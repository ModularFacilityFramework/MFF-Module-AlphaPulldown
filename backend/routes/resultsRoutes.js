// The Results tab's backend: the completed predictions of a project with the
// scores AlphaFold 3 gave them (read once from each job's summary file by the
// prediction routes, see cofoldRoutes.js), sortable and filterable in SQL, plus
// downloads of the best model and its summary file and a CSV of everything.
// Every query is scoped to req.user.id through the project. File paths are
// always built from database ids, never from anything the caller sends.
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { predictionJobDir } = require('../services/projectPaths');
const { httpError, makeHelpers } = require('../services/routeHelpers');
const results = require('../services/foldResults');

const PAGE = 50;
const MAX_PAGE = 200;
const CSV_ROWS = 100000;
// Column a sort key orders by. Only these - the key never reaches SQL itself.
const SORTS = {
  iptm: 'iptm',
  ptm: 'ptm',
  ranking: 'ranking_score',
  pae: 'interface_pae_min',
  bait: 'bait_name',
  cand: 'cand_name',
  length: '(len_a + COALESCE(len_b, 0))'
};
// pae is better when LOW, so its natural order is ascending; everything else
// reads best-first when descending.
const DEFAULT_DIRECTION = { pae: 'asc', bait: 'asc', cand: 'asc' };
const COMPLETED = "state LIKE 'COMPLETED%'";

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toRow(r) {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    bait: r.bait_name,
    cand: r.cand_name,
    lenA: r.len_a,
    lenB: r.len_b,
    iptm: r.iptm,
    ptm: r.ptm,
    rankingScore: r.ranking_score,
    interfacePaeMin: r.interface_pae_min,
    hasClash: r.has_clash === null || r.has_clash === undefined ? null : !!r.has_clash,
    scored: !!r.scored_at,
    endedAt: r.ended_at
  };
}

// The fold folder of a finished job that holds AlphaFold 3's summary file,
// with the names of its best model and summary. null when there is none.
async function findFoldFiles(jobDir) {
  let folders;
  try {
    folders = await fs.readdir(path.join(jobDir, 'output'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  for (const folder of folders.filter(f => f.isDirectory())) {
    const dir = path.join(jobDir, 'output', folder.name);
    const picked = results.pickFiles(await fs.readdir(dir));
    if (picked.summary || picked.model) return { dir, ...picked };
  }
  return null;
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();
  const auth = coreApi.authenticateToken;
  const { withConn, requireProject } = makeHelpers(coreApi);

  // WHERE clause shared by the list and the CSV.
  function filterOf(project, query) {
    const where = [`project_id = ?`, COMPLETED];
    const params = [project.id];
    const minIptm = query.minIptm === undefined || query.minIptm === '' ? null : Number(query.minIptm);
    if (minIptm !== null) {
      if (!Number.isFinite(minIptm)) throw httpError(400, 'minIptm must be a number');
      where.push('iptm >= ?');
      params.push(minIptm);
    }
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      where.push('(bait_name LIKE ? OR cand_name LIKE ?)');
      params.push(like, like);
    }
    return { where: where.join(' AND '), params };
  }

  function orderOf(query) {
    const key = SORTS[query.sort] ? query.sort : 'iptm';
    const direction = query.dir === 'asc' || query.dir === 'desc' ? query.dir : (DEFAULT_DIRECTION[key] || 'desc');
    const column = SORTS[key];
    // Unscored rows always last, whichever way the column runs.
    return `${column} IS NULL, ${column} ${direction === 'asc' ? 'ASC' : 'DESC'}, id`;
  }

  // GET /api/alphapulldown/projects/:id/results?sort=&dir=&minIptm=&q=&offset=&limit=
  router.get('/projects/:id/results', auth, withConn('Failed to read the results', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const { where, params } = filterOf(project, req.query);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE));
    const [count] = await conn.query(`SELECT COUNT(*) AS n FROM alphapulldown_cofold_items WHERE ${where}`, params);
    const rows = await conn.query(
      `SELECT * FROM alphapulldown_cofold_items WHERE ${where} ORDER BY ${orderOf(req.query)} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [totals] = await conn.query(
      `SELECT COUNT(*) AS completed, SUM(scored_at IS NOT NULL AND iptm IS NULL AND ptm IS NULL) AS unscored
       FROM alphapulldown_cofold_items WHERE project_id = ? AND ${COMPLETED}`,
      [project.id]
    );
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    res.json({
      total: Number(count.n),
      offset,
      completed: Number(totals.completed),
      unscored: Number(totals.unscored || 0),
      monomerMode: project.mode === 'homo_oligomer',
      items: rows.map(toRow),
      // Where the predictions live, for opening them in APLit or a viewer.
      folder: workspace.active ? path.join(path.dirname(predictionJobDir(workspace.path, project.project_number, 0, 0)), '..') : null
    });
  }));

  // GET /api/alphapulldown/projects/:id/results.csv - every completed complex, best first
  router.get('/projects/:id/results.csv', auth, withConn('Failed to export the results', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const { where, params } = filterOf(project, req.query);
    const rows = await conn.query(
      `SELECT * FROM alphapulldown_cofold_items WHERE ${where} ORDER BY ${orderOf(req.query)} LIMIT ?`,
      [...params, CSV_ROWS]
    );
    const lines = [['bait', 'candidate', 'bait_length', 'candidate_length', 'iptm', 'ptm', 'ranking_score', 'interface_pae_min', 'has_clash', 'run', 'job'].join(',')];
    rows.map(toRow).forEach(r => lines.push([
      r.bait, r.cand, r.lenA, r.lenB, r.iptm, r.ptm, r.rankingScore, r.interfacePaeMin,
      r.hasClash === null ? '' : (r.hasClash ? 1 : 0), r.runId, r.id
    ].map(csvCell).join(',')));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.send(`${lines.join('\n')}\n`);
  }));

  // GET /api/alphapulldown/projects/:id/results/:itemId/download?file=model|summary
  router.get('/projects/:id/results/:itemId/download', auth, withConn('Failed to download the file', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    if (!['model', 'summary'].includes(req.query.file)) throw httpError(400, 'file must be model or summary');
    const rows = await conn.query(
      `SELECT * FROM alphapulldown_cofold_items WHERE id = ? AND project_id = ? AND ${COMPLETED}`,
      [req.params.itemId, project.id]
    );
    if (!rows[0]) throw httpError(404, 'Result not found');
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    if (!workspace.active) throw httpError(503, 'Workspace storage is not available for this user.');
    const found = await findFoldFiles(predictionJobDir(workspace.path, project.project_number, rows[0].run_id, rows[0].id));
    const name = req.query.file === 'model' ? found && found.model : found && found.summary;
    if (!name) throw httpError(404, 'The job left no such file.');
    res.download(path.join(found.dir, name), name);
  }));

  return router;
};
