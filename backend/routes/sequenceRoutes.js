// The Sequences tab's backend: UniProt search, proteome download and
// browsing, adding/removing a project's proteins, and writing the FASTA and
// protein-list files AlphaPulldown reads. Every project query is scoped to
// req.user.id. Everything this module needs from core comes through coreApi
// (see docs/MFF-Core_module-core-api.md).
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { rolesForMode } = require('../services/sequenceStats');
const { projectDir } = require('../services/projectPaths');
const { findProject } = require('../services/projectAccess');
const fasta = require('../services/fastaTools');
const uniprot = require('../services/uniprotClient');
const proteomeStore = require('../services/proteomeStore');
const { filterEntries, summarize } = require('../services/proteomeIndex');

const MAX_SEQUENCES_PER_PROJECT = 25000;
const MAX_PASTE_CHARS = 2000000;
const MAX_ACCESSIONS_PER_REQUEST = 500;
const MAX_PROTEOME_ACCESSIONS = 5000;
const MAX_REMOVE_IDS = 5000;
const MAX_REPORTED_PROBLEMS = 100;
const MAX_COPIES = 50;
const INSERT_BATCH = 500;
const SOURCES = ['paste', 'uniprot', 'proteome'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function intParam(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function fileNamesFor(mode) {
  return mode === 'pulldown'
    ? ['baits.fasta', 'candidates.fasta', 'baits.txt', 'candidates.txt']
    : ['proteins.fasta', 'proteins.txt'];
}

// rows: [{ role, name, sequence, copies }] in insertion order.
function renderFiles(mode, rows) {
  if (mode === 'pulldown') {
    const baits = rows.filter(r => r.role === 'bait');
    const candidates = rows.filter(r => r.role === 'candidate');
    return [
      { name: 'baits.fasta', content: fasta.formatFasta(baits) },
      { name: 'candidates.fasta', content: fasta.formatFasta(candidates) },
      { name: 'baits.txt', content: fasta.formatList(baits) },
      { name: 'candidates.txt', content: fasta.formatList(candidates) }
    ];
  }
  return [
    { name: 'proteins.fasta', content: fasta.formatFasta(rows) },
    { name: 'proteins.txt', content: fasta.formatList(rows) }
  ];
}

function normalizeFilter(filter) {
  const f = filter || {};
  const q = typeof f.q === 'string' ? f.q.slice(0, 200) : '';
  const minLen = Math.max(0, parseInt(f.minLen, 10) || 0);
  const maxLenParsed = parseInt(f.maxLen, 10);
  return { q, minLen, maxLen: Number.isNaN(maxLenParsed) || maxLenParsed <= 0 ? Infinity : maxLenParsed };
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();
  const auth = coreApi.authenticateToken;

  // Wraps a handler that needs a database connection: releases it, and turns
  // thrown httpError()s into their status and anything else into a 500.
  function withConn(failureMessage, handler) {
    return async (req, res) => {
      const conn = await coreApi.pool.getConnection();
      try {
        await handler(req, res, conn);
      } catch (err) {
        res.status(err.status || 500).json({ error: err.status ? err.message : failureMessage, message: err.message });
      } finally {
        conn.release();
      }
    };
  }

  // Wraps a handler that only talks to UniProt or the disk.
  function plain(failureMessage, handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        res.status(err.status || 500).json({ error: err.status ? err.message : failureMessage, message: err.message });
      }
    };
  }

  async function requireProject(conn, req) {
    const project = await findProject(conn, req.params.id, req.user.id);
    if (!project) throw httpError(404, 'Project not found');
    return project;
  }

  async function requireWorkspace(req) {
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    if (!workspace.active) throw httpError(503, 'Workspace storage is not available for this user.');
    return workspace;
  }

  // UniProt being down or unreachable is the server's problem, not the
  // user's request being wrong.
  async function fromUniprot(call) {
    try {
      return await call();
    } catch (err) {
      throw httpError(502, `UniProt could not be reached: ${err.message}`);
    }
  }

  // ---- UniProt ----------------------------------------------------------

  router.get('/uniprot/search', auth, plain('UniProt search failed', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const organism = String(req.query.organism || '').trim();
    if (!q) throw httpError(400, 'q is required');
    if (q.length > 200 || organism.length > 100) throw httpError(400, 'Search text is too long');
    const results = await fromUniprot(() => uniprot.searchProteins({ query: q, organism, reviewedOnly: req.query.reviewed !== '0' }));
    res.json({ results });
  }));

  router.get('/uniprot/proteomes', auth, plain('Proteome search failed', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) throw httpError(400, 'q is required');
    if (q.length > 200) throw httpError(400, 'Search text is too long');
    res.json({ results: await fromUniprot(() => uniprot.searchProteomes({ query: q })) });
  }));

  // ---- Proteomes kept in the user's workspace ---------------------------

  router.get('/proteomes', auth, plain('Failed to list proteomes', async (req, res) => {
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    res.json({
      workspace: { active: workspace.active, reason: workspace.reason },
      local: workspace.active ? await proteomeStore.listLocal(workspace.path) : [],
      downloads: proteomeStore.downloadsFor(req.user.id)
    });
  }));

  router.post('/proteomes/:upid/download', auth, plain('Failed to start download', async (req, res) => {
    if (!uniprot.UPID.test(req.params.upid)) throw httpError(400, 'Not a proteome id (expected UP followed by 9 digits)');
    const workspace = await requireWorkspace(req);
    res.status(202).json(proteomeStore.startDownload({
      userId: req.user.id,
      workspacePath: workspace.path,
      upid: req.params.upid,
      reviewedOnly: !!(req.body && req.body.reviewedOnly)
    }));
  }));

  router.get('/proteomes/:upid/entries', auth, plain('Failed to read proteome', async (req, res) => {
    if (!uniprot.UPID.test(req.params.upid)) throw httpError(400, 'Not a proteome id');
    const workspace = await requireWorkspace(req);
    let index;
    try {
      index = await proteomeStore.loadIndex(workspace.path, req.params.upid, req.query.reviewedOnly === '1');
    } catch (err) {
      if (err.code === 'ENOENT') throw httpError(404, 'This proteome has not been downloaded');
      throw err;
    }
    const filtered = filterEntries(index, normalizeFilter({ q: req.query.q, minLen: req.query.minLen, maxLen: req.query.maxLen }));
    const page = intParam(req.query.page, 1, 1, 1000000);
    const limit = intParam(req.query.limit, 50, 1, 200);
    res.json({ total: filtered.length, page, limit, items: filtered.slice((page - 1) * limit, page * limit).map(summarize) });
  }));

  router.delete('/proteomes/:upid', auth, plain('Failed to delete proteome', async (req, res) => {
    if (!uniprot.UPID.test(req.params.upid)) throw httpError(400, 'Not a proteome id');
    const workspace = await requireWorkspace(req);
    await proteomeStore.remove(workspace.path, req.params.upid, req.query.reviewedOnly === '1');
    res.json({ success: true });
  }));

  // ---- A project's sequences --------------------------------------------

  router.get('/projects/:id/sequences', auth, withConn('Failed to list sequences', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const where = ['project_id = ?'];
    const params = [project.id];
    if (req.query.role) {
      if (!rolesForMode(project.mode).includes(req.query.role)) throw httpError(400, 'Unknown role for this project');
      where.push('role = ?');
      params.push(req.query.role);
    }
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push('(name LIKE ? OR description LIKE ?)');
      params.push(like, like);
    }
    const page = intParam(req.query.page, 1, 1, 1000000);
    const limit = intParam(req.query.limit, 50, 1, 200);
    const [{ total }] = await conn.query(`SELECT COUNT(*) AS total FROM alphapulldown_project_sequences WHERE ${where.join(' AND ')}`, params);
    const items = await conn.query(
      `SELECT id, role, name, source, description, length, copies FROM alphapulldown_project_sequences
       WHERE ${where.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ total, page, limit, items });
  }));

  // Turns a request body into candidate entries ({ name, description,
  // sequence, length, errors[] }) plus problems found on the way.
  async function collectEntries(req, body, problems) {
    if (body.source === 'paste') {
      if (typeof body.text !== 'string' || !body.text.trim()) throw httpError(400, 'text is required');
      if (body.text.length > MAX_PASTE_CHARS) throw httpError(400, 'Too much text in one request');
      const records = fasta.parseFasta(body.text);
      if (records.length === 0) throw httpError(400, 'No sequences found in the text');
      return records.map((record, i) => fasta.buildEntry(record, `sequence_${i + 1}`));
    }

    if (body.source === 'uniprot') {
      const requested = [...new Set((Array.isArray(body.accessions) ? body.accessions : []).map(a => String(a).trim().toUpperCase()).filter(Boolean))];
      if (requested.length === 0) throw httpError(400, 'accessions is required');
      if (requested.length > MAX_ACCESSIONS_PER_REQUEST) throw httpError(400, `At most ${MAX_ACCESSIONS_PER_REQUEST} accessions at a time`);
      const valid = requested.filter(a => uniprot.ACCESSION.test(a));
      requested.filter(a => !uniprot.ACCESSION.test(a)).forEach(a => problems.push({ name: a, reason: 'not a valid UniProt accession' }));
      if (valid.length === 0) return [];
      const text = await fromUniprot(() => uniprot.fetchFasta(valid));
      const entries = fasta.parseFasta(text).map(record => fasta.buildEntry(record, ''));
      const found = new Set(entries.map(e => e.name.toUpperCase()));
      valid.filter(a => !found.has(a)).forEach(a => problems.push({ name: a, reason: 'UniProt has no entry with this accession' }));
      return entries;
    }

    if (body.source === 'proteome') {
      if (!uniprot.UPID.test(body.upid || '')) throw httpError(400, 'upid is required');
      const workspace = await requireWorkspace(req);
      let index;
      try {
        index = await proteomeStore.loadIndex(workspace.path, body.upid, !!body.reviewedOnly);
      } catch (err) {
        if (err.code === 'ENOENT') throw httpError(404, 'This proteome has not been downloaded');
        throw err;
      }
      let selected;
      if (Array.isArray(body.accessions)) {
        if (body.accessions.length > MAX_PROTEOME_ACCESSIONS) throw httpError(400, `Select at most ${MAX_PROTEOME_ACCESSIONS} proteins by hand; use a filter for more`);
        const wanted = new Set(body.accessions.map(String));
        selected = index.filter(e => wanted.has(e.accession));
      } else if (body.filter) {
        selected = filterEntries(index, normalizeFilter(body.filter));
      } else {
        throw httpError(400, 'accessions or filter is required');
      }
      return selected.map(e => ({
        name: fasta.sanitizeName(e.accession),
        description: e.description.slice(0, 500),
        sequence: e.sequence,
        length: e.length,
        errors: fasta.validateSequence(e.sequence)
      }));
    }

    throw httpError(400, `source must be one of ${SOURCES.join(', ')}`);
  }

  // POST /api/alphapulldown/projects/:id/sequences
  //   { role, source: 'paste', text }
  //   { role, source: 'uniprot', accessions: [...] }
  //   { role, source: 'proteome', upid, reviewedOnly, accessions: [...] | filter: { q, minLen, maxLen } }
  // Entries that cannot be added (bad residues, too short, already in the
  // list) are reported back, not treated as a failure of the whole request.
  router.post('/projects/:id/sequences', auth, withConn('Failed to add sequences', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const body = req.body || {};
    if (!rolesForMode(project.mode).includes(body.role)) {
      throw httpError(400, `role must be one of ${rolesForMode(project.mode).join(', ')} for this project`);
    }

    const problems = [];
    const entries = await collectEntries(req, body, problems);

    const valid = [];
    entries.forEach(entry => {
      if (entry.errors.length > 0) problems.push({ name: entry.name || '(no name)', reason: entry.errors.join('; ') });
      else valid.push(entry);
    });

    const existing = new Set(
      (await conn.query('SELECT name FROM alphapulldown_project_sequences WHERE project_id = ? AND role = ?', [project.id, body.role])).map(r => r.name)
    );
    const fresh = [];
    fasta.uniqueNames(valid).forEach(entry => {
      if (existing.has(entry.name)) problems.push({ name: entry.name, reason: 'already in this list' });
      else fresh.push(entry);
    });

    const [{ total }] = await conn.query('SELECT COUNT(*) AS total FROM alphapulldown_project_sequences WHERE project_id = ?', [project.id]);
    if (total + fresh.length > MAX_SEQUENCES_PER_PROJECT) {
      throw httpError(400, `A project holds at most ${MAX_SEQUENCES_PER_PROJECT.toLocaleString()} sequences (it has ${total}, this would add ${fresh.length})`);
    }

    if (fresh.length > 0) {
      await conn.beginTransaction();
      try {
        for (let i = 0; i < fresh.length; i += INSERT_BATCH) {
          const batch = fresh.slice(i, i + INSERT_BATCH);
          await conn.query(
            `INSERT INTO alphapulldown_project_sequences (project_id, role, name, source, description, length, sequence)
             VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            batch.flatMap(e => [project.id, body.role, e.name, body.source, e.description || null, e.length, e.sequence])
          );
        }
        await conn.query('UPDATE alphapulldown_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [project.id]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    }

    res.status(201).json({ added: fresh.length, skippedCount: problems.length, skipped: problems.slice(0, MAX_REPORTED_PROBLEMS) });
  }));

  // PATCH /api/alphapulldown/projects/:id/sequences/:seqId - { copies }
  router.patch('/projects/:id/sequences/:seqId', auth, withConn('Failed to update sequence', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const copies = Number((req.body || {}).copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw httpError(400, `copies must be a whole number from 1 to ${MAX_COPIES}`);
    const result = await conn.query(
      'UPDATE alphapulldown_project_sequences SET copies = ? WHERE id = ? AND project_id = ?',
      [copies, req.params.seqId, project.id]
    );
    if (result.affectedRows === 0) throw httpError(404, 'Sequence not found');
    await conn.query('UPDATE alphapulldown_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [project.id]);
    res.json({ success: true });
  }));

  // POST /api/alphapulldown/projects/:id/sequences/remove - { ids } | { role } | { all: true }
  // POST rather than DELETE-with-a-body, which some proxies drop.
  router.post('/projects/:id/sequences/remove', auth, withConn('Failed to remove sequences', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const body = req.body || {};
    let result;
    if (Array.isArray(body.ids)) {
      const ids = body.ids.map(Number).filter(Number.isInteger);
      if (ids.length === 0 || ids.length > MAX_REMOVE_IDS) throw httpError(400, `ids must hold 1 to ${MAX_REMOVE_IDS} sequence ids`);
      result = await conn.query(
        `DELETE FROM alphapulldown_project_sequences WHERE project_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
        [project.id, ...ids]
      );
    } else if (body.role) {
      if (!rolesForMode(project.mode).includes(body.role)) throw httpError(400, 'Unknown role for this project');
      result = await conn.query('DELETE FROM alphapulldown_project_sequences WHERE project_id = ? AND role = ?', [project.id, body.role]);
    } else if (body.all === true) {
      result = await conn.query('DELETE FROM alphapulldown_project_sequences WHERE project_id = ?', [project.id]);
    } else {
      throw httpError(400, 'Send ids, role or all');
    }
    await conn.query('UPDATE alphapulldown_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [project.id]);
    res.json({ removed: result.affectedRows });
  }));

  // ---- The files AlphaPulldown reads ------------------------------------

  async function describeFiles(req, project) {
    const names = fileNamesFor(project.mode);
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    if (!workspace.active) {
      return { workspace: { active: false, reason: workspace.reason }, dir: null, files: names.map(name => ({ name, exists: false })), projectUpdatedAt: project.updated_at };
    }
    const dir = projectDir(workspace.path, project.project_number);
    const files = [];
    for (const name of names) {
      try {
        const stat = await fs.stat(path.join(dir, name));
        files.push({ name, exists: true, size: stat.size, modified: stat.mtime });
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        files.push({ name, exists: false });
      }
    }
    return { workspace: { active: true }, dir, files, projectUpdatedAt: project.updated_at };
  }

  router.get('/projects/:id/files', auth, withConn('Failed to list project files', async (req, res, conn) => {
    res.json(await describeFiles(req, await requireProject(conn, req)));
  }));

  // POST /api/alphapulldown/projects/:id/files - (re)writes every file for
  // the project's current sequences.
  router.post('/projects/:id/files', auth, withConn('Failed to write project files', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const workspace = await requireWorkspace(req);
    const rows = await conn.query(
      'SELECT role, name, sequence, copies FROM alphapulldown_project_sequences WHERE project_id = ? ORDER BY id',
      [project.id]
    );
    if (project.mode === 'pulldown') {
      if (!rows.some(r => r.role === 'bait') || !rows.some(r => r.role === 'candidate')) {
        throw httpError(400, 'Add at least one bait and one candidate first');
      }
    } else if (rows.length === 0) {
      throw httpError(400, 'Add at least one sequence first');
    }

    const dir = projectDir(workspace.path, project.project_number);
    await fs.mkdir(dir, { recursive: true });
    for (const file of renderFiles(project.mode, rows)) {
      await fs.writeFile(path.join(dir, file.name), file.content, 'utf8');
    }
    res.json(await describeFiles(req, project));
  }));

  // GET /api/alphapulldown/projects/:id/files/:name - only the fixed file
  // names this module writes can be fetched, never an arbitrary path.
  router.get('/projects/:id/files/:name', auth, withConn('Failed to download file', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    if (!fileNamesFor(project.mode).includes(req.params.name)) throw httpError(404, 'File not found');
    const workspace = await requireWorkspace(req);
    let content;
    try {
      content = await fs.readFile(path.join(projectDir(workspace.path, project.project_number), req.params.name));
    } catch (err) {
      throw httpError(404, 'File has not been written yet');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.type('text/plain').send(content);
  }));

  return router;
};
