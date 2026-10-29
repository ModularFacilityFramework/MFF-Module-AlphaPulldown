// The MSA (CPU) tab's backend: plan a run, write its scripts into the
// project's folder, submit it through the Slurm module, follow it, and copy
// its timings (anonymised) into the speed database once it ends. Every query
// is scoped to req.user.id. Everything this module needs from core comes
// through coreApi (see docs/MFF-Core_module-core-api.md); the Slurm module is
// reached only through coreApi.callModule, with the calling user's own token.
//
// There is no background process: a run's state is refreshed from Slurm, and
// its timings ingested, whenever its owner lists or opens it.
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { projectDir, isInside } = require('../services/projectPaths');
const { getRequestContext } = require('../services/requestContext');
const { loadSettings } = require('../services/settingsStore');
const { msaProfile } = require('../services/speedProfiles');
const { recordSamples } = require('../services/speedRecorder');
const slurm = require('../services/slurmClient');
const { httpError, makeHelpers } = require('../services/routeHelpers');
const plan = require('../services/msaPlan');

const FEATURES_DIRNAME = 'features';
const MAX_LISTED_RUNS = 50;
const MAX_FAILED_LISTED = 200;
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_FILES = ['slurm.out', 'slurm.err'];

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// Names that already have a features file (<name>.pkl or <name>.pkl.xz).
async function namesWithFeatures(dir) {
  try {
    const entries = await fs.readdir(dir);
    return new Set(entries.map(e => e.replace(/\.pkl(\.xz)?$/, '')).filter((n, i) => n !== entries[i]));
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();
  const auth = coreApi.authenticateToken;
  const { withConn, requireProject, requireWorkspace } = makeHelpers(coreApi);

  async function requireRun(conn, req, project) {
    const rows = await conn.query(
      'SELECT * FROM alphapulldown_msa_runs WHERE id = ? AND project_id = ? AND owner_id = ?',
      [req.params.runId, project.id, req.user.id]
    );
    if (!rows[0]) throw httpError(404, 'Run not found');
    return rows[0];
  }

  // Absolute folder of a run, only ever inside the user's own project folder.
  function runPath(workspace, project, run) {
    const base = projectDir(workspace.path, project.project_number);
    const dir = path.join(base, run.run_dir);
    if (!isInside(path.join(base, 'msa'), dir) || dir === path.join(base, 'msa')) throw httpError(500, 'Run folder is outside the project');
    return dir;
  }

  // Everything a run depends on, or the reasons it cannot start. Used by the
  // preview and, unchanged, by the start route so they can never disagree.
  async function evaluate(req, conn, project, { redo }) {
    const settings = await loadSettings(conn, req.user.id);
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    const rows = await conn.query(
      'SELECT name, length, sequence FROM alphapulldown_project_sequences WHERE project_id = ? ORDER BY id',
      [project.id]
    );
    const { proteins, conflicts } = plan.uniqueProteins(rows);

    const problems = plan.msaProblems(settings);
    if (!workspace.active) problems.push('Workspace storage is not available for your account, so there is nowhere to write the run.');
    if (proteins.length === 0) problems.push('Add sequences in the Sequences tab first.');
    if (conflicts.length > 0) {
      problems.push(`These names carry two different sequences (for example as bait and as candidate); rename one: ${conflicts.slice(0, 10).join(', ')}${conflicts.length > 10 ? ', ...' : ''}`);
    }

    let done = 0;
    let featuresDir = null;
    if (workspace.active) {
      featuresDir = path.join(projectDir(workspace.path, project.project_number), FEATURES_DIRNAME);
      if (!redo) {
        const existing = await namesWithFeatures(featuresDir);
        done = proteins.filter(p => existing.has(p.name)).length;
      }
    }
    const toDo = proteins.length - done;
    return { settings, workspace, proteins, problems, done, toDo, featuresDir, redo };
  }

  function buildFiles(info, email, slug) {
    return plan.buildRunFiles({
      slug,
      settings: info.settings,
      email,
      resources: plan.msaResources(info.settings, info.toDo),
      proteins: info.proteins,
      featuresDir: info.featuresDir,
      redo: info.redo
    });
  }

  async function activeRunOf(conn, projectId) {
    const rows = await conn.query('SELECT id, state FROM alphapulldown_msa_runs WHERE project_id = ? ORDER BY id DESC', [projectId]);
    return rows.find(r => !plan.isTerminalState(r.state)) || null;
  }

  // GET /api/alphapulldown/projects/:id/msa/plan?redo=1 - what a run would be
  router.get('/projects/:id/msa/plan', auth, withConn('Failed to prepare the MSA plan', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const info = await evaluate(req, conn, project, { redo: req.query.redo === '1' });
    const resources = plan.msaResources(info.settings, info.toDo);
    const { email } = await getRequestContext(coreApi, req);
    const files = info.proteins.length > 0 && info.featuresDir
      ? buildFiles(info, email, `ap-msa-P${project.project_number}`)
      : null;
    res.json({
      problems: info.problems,
      proteins: info.proteins.length,
      alreadyDone: info.done,
      toDo: info.toDo,
      redo: info.redo,
      method: msaProfile(info.settings).method,
      resources: {
        parallel: resources.parallel,
        rounds: resources.rounds,
        cpus: resources.cpus,
        memMB: resources.memMB,
        time: resources.time,
        partition: info.settings.msa_partition || null
      },
      scripts: files ? { 'submit.sh': files['submit.sh'], 'run_one.sh': files['run_one.sh'] } : null,
      activeRun: await activeRunOf(conn, project.id)
    });
  }));

  // POST /api/alphapulldown/projects/:id/msa/runs - { redo? }
  router.post('/projects/:id/msa/runs', auth, withConn('Failed to start the MSA run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const redo = !!(req.body && req.body.redo);
    const info = await evaluate(req, conn, project, { redo });
    if (info.problems.length > 0) throw httpError(400, info.problems[0]);
    if (info.toDo === 0) throw httpError(400, 'Every protein already has its features. Tick "search again" to redo them.');
    if (await activeRunOf(conn, project.id)) throw httpError(409, 'A run for this project is still going. Wait for it or cancel it first.');

    const { email } = await getRequestContext(coreApi, req);
    const resources = plan.msaResources(info.settings, info.toDo);
    const profile = msaProfile(info.settings);
    const insert = await conn.query(
      `INSERT INTO alphapulldown_msa_runs (project_id, owner_id, run_dir, total, to_do, parallel, redo, method, hardware)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`,
      [project.id, req.user.id, info.proteins.length, info.toDo, resources.parallel, redo ? 1 : 0, profile.method, profile.hardware]
    );
    const runId = Number(insert.insertId);
    const run = { run_dir: path.join('msa', `run-${runId}`) };
    const dir = runPath(info.workspace, project, run);

    try {
      const files = buildFiles(info, email, `ap-msa-P${project.project_number}`);
      await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
      await fs.mkdir(info.featuresDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content, { encoding: 'utf8', mode: name.endsWith('.sh') ? 0o755 : 0o644 });
      }
      const submitted = await slurm.submitJob(coreApi, req.headers.authorization, { workDir: dir, jobName: `ap-msa-P${project.project_number}` });
      if (!submitted.success) {
        throw httpError(502, submitted.status === 403
          ? 'You are not a registered Slurm user, so the job could not be submitted.'
          : `The Slurm module did not accept the job: ${submitted.error}`);
      }
      await conn.query(
        "UPDATE alphapulldown_msa_runs SET run_dir = ?, slurm_job_id = ?, state = 'PENDING' WHERE id = ?",
        [run.run_dir, String(submitted.jobId), runId]
      );
    } catch (err) {
      await conn.query('DELETE FROM alphapulldown_msa_runs WHERE id = ?', [runId]);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    res.status(201).json({ id: runId });
  }));

  // Asks Slurm where an unfinished run is and stores the answer. A Slurm
  // module that cannot be reached leaves the stored state alone and says so.
  async function refreshRun(conn, req, run) {
    if (plan.isTerminalState(run.state) || !run.slurm_job_id) return { run };
    const status = await slurm.getJobStatus(coreApi, req.headers.authorization, run.slurm_job_id);
    if (!status.success) return { run, statusError: status.error || 'Slurm status unavailable' };
    const next = {
      ...run,
      state: String(status.state || run.state).slice(0, 30),
      started_at: toDate(status.startedAt) || run.started_at,
      ended_at: toDate(status.endedAt) || run.ended_at
    };
    await conn.query('UPDATE alphapulldown_msa_runs SET state = ?, started_at = ?, ended_at = ? WHERE id = ?', [next.state, next.started_at, next.ended_at, run.id]);
    return { run: next };
  }

  // Once a run has ended, copies its timings into the speed database - once.
  // The marker is claimed first, so two requests at the same moment cannot
  // both ingest; if recording then fails the claim is released for next time.
  async function ingestIfDone(conn, run, dir) {
    if (!plan.isTerminalState(run.state) || run.speed_ingested_at) return 0;
    const claimed = await conn.query(
      'UPDATE alphapulldown_msa_runs SET speed_ingested_at = NOW() WHERE id = ? AND speed_ingested_at IS NULL',
      [run.id]
    );
    if (claimed.affectedRows !== 1) return 0;
    try {
      const timings = plan.parseTimings(await readTextIfExists(path.join(dir, 'timings.tsv')));
      return await recordSamples(conn, plan.samplesFromTimings(timings, { method: run.method, hardware: run.hardware }));
    } catch (err) {
      await conn.query('UPDATE alphapulldown_msa_runs SET speed_ingested_at = NULL WHERE id = ?', [run.id]);
      throw err;
    }
  }

  function describeRun(run, timings, statusError) {
    return {
      id: Number(run.id),
      slurmJobId: run.slurm_job_id,
      state: run.state,
      total: run.total,
      toDo: run.to_do,
      parallel: run.parallel,
      redo: !!run.redo,
      method: run.method,
      createdAt: run.created_at,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      progress: plan.progressOf(timings),
      active: !plan.isTerminalState(run.state),
      statusError: statusError || null
    };
  }

  // GET /api/alphapulldown/projects/:id/msa/runs - newest first, each brought up to date
  router.get('/projects/:id/msa/runs', auth, withConn('Failed to list MSA runs', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    const rows = await conn.query(
      'SELECT * FROM alphapulldown_msa_runs WHERE project_id = ? AND owner_id = ? ORDER BY id DESC LIMIT ?',
      [project.id, req.user.id, MAX_LISTED_RUNS]
    );
    const runs = [];
    let ingestedNow = 0;
    for (const row of rows) {
      const { run, statusError } = await refreshRun(conn, req, row);
      let timings = [];
      if (workspace.active && run.run_dir) {
        const dir = runPath(workspace, project, run);
        ingestedNow += await ingestIfDone(conn, run, dir);
        timings = plan.parseTimings(await readTextIfExists(path.join(dir, 'timings.tsv')));
      }
      runs.push(describeRun(run, timings, statusError));
    }
    res.json({ runs, ingestedNow });
  }));

  // GET /api/alphapulldown/projects/:id/msa/runs/:runId - one run plus the proteins that failed
  router.get('/projects/:id/msa/runs/:runId', auth, withConn('Failed to read the MSA run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const workspace = await requireWorkspace(req);
    const { run, statusError } = await refreshRun(conn, req, await requireRun(conn, req, project));
    const dir = runPath(workspace, project, run);
    await ingestIfDone(conn, run, dir);
    const timings = plan.parseTimings(await readTextIfExists(path.join(dir, 'timings.tsv')));
    const names = (await readTextIfExists(path.join(dir, 'msa_names.txt'))).split('\n');
    const failed = timings
      .filter(t => t.status === 'failed' || t.status === 'oom')
      .slice(0, MAX_FAILED_LISTED)
      .map(t => ({ index: t.index, name: names[t.index - 1] || '', length: t.length, status: t.status, exit: t.exit, seconds: t.seconds }));
    res.json({ ...describeRun(run, timings, statusError), failed });
  }));

  // GET /api/alphapulldown/projects/:id/msa/runs/:runId/log?file=slurm.out|slurm.err|protein&index=N
  // The last 64 KB of one log file, as { text, truncated }.
  router.get('/projects/:id/msa/runs/:runId/log', auth, withConn('Failed to read the log', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const workspace = await requireWorkspace(req);
    const run = await requireRun(conn, req, project);
    const dir = runPath(workspace, project, run);

    let file;
    if (LOG_FILES.includes(req.query.file)) {
      file = path.join(dir, req.query.file);
    } else if (req.query.file === 'protein') {
      const index = Number(req.query.index);
      if (!Number.isInteger(index) || index < 1 || index > run.total) throw httpError(400, 'index is not a protein of this run');
      file = path.join(dir, 'logs', `${index}.log`);
    } else {
      throw httpError(400, 'file must be slurm.out, slurm.err or protein');
    }

    let handle;
    try {
      handle = await fs.open(file, 'r');
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ text: '', truncated: false });
      throw err;
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      res.json({ text: buffer.toString('utf8'), truncated: size > length });
    } finally {
      await handle.close();
    }
  }));

  // POST /api/alphapulldown/projects/:id/msa/runs/:runId/cancel
  router.post('/projects/:id/msa/runs/:runId/cancel', auth, withConn('Failed to cancel the run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const run = await requireRun(conn, req, project);
    if (plan.isTerminalState(run.state)) throw httpError(409, 'This run has already finished.');
    if (!run.slurm_job_id) throw httpError(409, 'This run was never submitted.');
    const result = await slurm.cancelJob(coreApi, req.headers.authorization, run.slurm_job_id);
    if (!result.success) throw httpError(502, `The Slurm module could not cancel the job: ${result.error}`);
    res.json({ success: true, alreadyFinished: !!result.alreadyFinished });
  }));

  // DELETE /api/alphapulldown/projects/:id/msa/runs/:runId - the record and
  // its folder (never the features), only once the run is over or was never submitted.
  router.delete('/projects/:id/msa/runs/:runId', auth, withConn('Failed to delete the run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const run = await requireRun(conn, req, project);
    if (run.slurm_job_id && !plan.isTerminalState(run.state)) throw httpError(409, 'Cancel the run before deleting it.');
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    await conn.query('DELETE FROM alphapulldown_msa_runs WHERE id = ?', [run.id]);
    let folderRemoved = false;
    if (workspace.active && run.run_dir) {
      try {
        await fs.rm(runPath(workspace, project, run), { recursive: true, force: true });
        folderRemoved = true;
      } catch (err) {
        folderRemoved = false;
      }
    }
    res.json({ success: true, folderRemoved });
  }));

  return router;
};
