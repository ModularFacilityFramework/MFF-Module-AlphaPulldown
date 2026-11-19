// The Prediction (GPU) tab's backend: plan a run of complexes, predict each
// with its own Slurm job running AlphaPulldown's run_multimer_jobs.py
// (AlphaFold 3 backend) through the Slurm module, follow the jobs, read the
// scores of the ones that completed, and copy their timings (anonymised) into
// the speed database. Every query is scoped to req.user.id. The Slurm module is
// reached only through coreApi.callModule, with the calling user's own token.
//
// There is no background process. A run is only ever advanced by its owner
// opening or listing it: that refreshes the jobs already submitted, ingests
// the ones that ended, and submits queued complexes while fewer than the run's
// max_parallel are in flight. So a large run keeps moving only while its page
// is open; the tab says so. (The routes keep the historical /cofold path and
// the tables their cofold_ names.)
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { projectDir, featuresDir, predictionJobDir, jaxCacheDir } = require('../services/projectPaths');
const { loadSettings } = require('../services/settingsStore');
const { estimateRun } = require('../services/speedEstimator');
const { loadSamples, recordSamples } = require('../services/speedRecorder');
const slurm = require('../services/slurmClient');
const { getRequestContext } = require('../services/requestContext');
const { httpError, makeHelpers } = require('../services/routeHelpers');
const cofold = require('../services/cofoldPlan');
const { namesWithFeatures } = require('../services/featureFiles');
const results = require('../services/foldResults');

const PREDICTIONS_DIRNAME = 'predictions';
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_FILES = ['slurm.out', 'slurm.err'];
const SCORES_PER_SYNC = 100;
const SCORE_GIVE_UP_MINUTES = 10;
const MISSING_LISTED = 10;
const MAX_LISTED_RUNS = 20;
const ITEMS_PAGE = 100;
const STATUS_REFRESHES_PER_SYNC = 50;
const SUBMITS_PER_SYNC = 6;
const SYNC_BUDGET_MS = 25000;
const STALE_CLAIM_MINUTES = 5;
const INSERT_CHUNK = 500;
const PREVIEW_PAIRS = 10;

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function toSampleItem(row) {
  return {
    state: row.state,
    lenA: row.len_a,
    lenB: row.len_b,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    slurmSubmittedAt: row.slurm_submitted_at
  };
}

function optionsOf(run) {
  return { seeds: run.model_seeds, samples: run.diffusion_samples, recycles: run.num_recycles };
}

function emptyCounts() {
  return { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 };
}

// Scores of the best model of one finished job: looks inside output/ for the
// fold folder that holds AlphaFold 3's summary file. null = nothing there (yet).
async function readJobScores(jobDir) {
  let folders;
  try {
    folders = await fs.readdir(path.join(jobDir, 'output'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  for (const folder of folders.filter(f => f.isDirectory())) {
    const names = await fs.readdir(path.join(jobDir, 'output', folder.name));
    const { summary } = results.pickFiles(names);
    if (!summary) continue;
    const scores = results.scoresFromSummary(JSON.parse(await fs.readFile(path.join(jobDir, 'output', folder.name, summary), 'utf8')));
    if (scores) return scores;
  }
  return null;
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();
  const auth = coreApi.authenticateToken;
  const { withConn, requireProject } = makeHelpers(coreApi);
  // Runs being advanced right now by this process (two open tabs must not
  // both submit); the claim on each row guards across processes.
  const syncing = new Set();

  async function requireRun(conn, req, project) {
    const rows = await conn.query(
      'SELECT * FROM alphapulldown_cofold_runs WHERE id = ? AND project_id = ? AND owner_id = ?',
      [req.params.runId, project.id, req.user.id]
    );
    if (!rows[0]) throw httpError(404, 'Run not found');
    return rows[0];
  }

  async function projectRows(conn, project) {
    return conn.query(
      'SELECT role, name, length, copies, sequence FROM alphapulldown_project_sequences WHERE project_id = ? ORDER BY id',
      [project.id]
    );
  }

  // Complexes of this project that already completed, as a Set of pairKey()s.
  async function completedPairs(conn, project) {
    const rows = await conn.query(
      "SELECT bait_name, cand_name FROM alphapulldown_cofold_items WHERE project_id = ? AND state LIKE 'COMPLETED%'",
      [project.id]
    );
    return new Set(rows.map(r => cofold.pairKey(r.bait_name, r.cand_name)));
  }

  // True while anything of this project is queued or in flight, whichever run.
  async function hasUnfinished(conn, project) {
    const rows = await conn.query('SELECT DISTINCT state FROM alphapulldown_cofold_items WHERE project_id = ?', [project.id]);
    return rows.some(r => !cofold.isFinishedState(r.state));
  }

  // Everything a run depends on, or the reasons it cannot start. Used by the
  // plan and, unchanged, by the start route so they can never disagree.
  async function evaluate(req, conn, project, options) {
    const settings = await loadSettings(conn, req.user.id);
    const rows = await projectRows(conn, project);
    const problems = [];
    const selected = cofold.countSelection(project.mode, rows, options.baits);
    const empty = { settings, rows, problems, selection: null, selected, missing: [], workspace: null };

    if (rows.length === 0) {
      problems.push('Add sequences in the Sequences tab first.');
      return empty;
    }
    if (selected === 0) {
      problems.push(project.mode === 'pulldown'
        ? 'A pulldown needs at least one bait and one candidate (and the chosen baits must exist).'
        : 'There are no complexes to predict yet: add more proteins in the Sequences tab.');
      return empty;
    }
    if (selected > cofold.MAX_PAIRS_TO_PLAN) {
      problems.push(`This selection holds ${selected.toLocaleString()} complexes; choose fewer baits (at most ${cofold.MAX_PAIRS_TO_PLAN.toLocaleString()} can be planned at once).`);
      return empty;
    }

    const selection = cofold.selectPairs({
      mode: project.mode,
      rows,
      options,
      completed: await completedPairs(conn, project),
      limitAA: settings.warn_max_complex_aa
    });
    if (selection.tooMany) {
      problems.push(`${selection.eligible.toLocaleString()} complexes would run and one run holds at most ${cofold.MAX_PAIRS_PER_RUN.toLocaleString()}. Choose fewer baits or set a limit.`);
    }

    // Every protein of the run needs its features from the Features tab.
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    let missing = [];
    if (workspace.active) {
      const have = await namesWithFeatures(featuresDir(workspace.path, project.project_number));
      const needed = new Set();
      selection.pairs.forEach(p => {
        needed.add(p.bait.name);
        if (p.cand) needed.add(p.cand.name);
      });
      missing = [...needed].filter(name => !have.has(name));
      if (missing.length > 0) {
        const shown = missing.slice(0, MISSING_LISTED).join(', ');
        problems.push(`${missing.length.toLocaleString()} protein${missing.length === 1 ? ' has' : 's have'} no features yet (${shown}${missing.length > MISSING_LISTED ? ', ...' : ''}). Run the Features tab first.`);
      }
    } else {
      problems.push('Workspace storage is not available for your account, so there is nowhere to write the jobs.');
    }
    return { settings, rows, problems, selection, selected, missing, workspace };
  }

  function parseQueryOptions(query) {
    const { errors, options } = cofold.normaliseOptions({
      seeds: query.seeds,
      samples: query.samples,
      recycles: query.recycles,
      includeOversize: query.includeOversize === '1',
      limit: query.limit === undefined || query.limit === '' ? undefined : Number(query.limit),
      baits: query.baits ? String(query.baits).split(',').filter(Boolean) : undefined
    });
    if (errors.length > 0) throw httpError(400, errors[0]);
    return options;
  }

  // GET /api/alphapulldown/projects/:id/cofold/plan?seeds=&samples=&recycles=&includeOversize=1&limit=&baits=a,b
  router.get('/projects/:id/cofold/plan', auth, withConn('Failed to prepare the prediction plan', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const options = parseQueryOptions(req.query);
    const info = await evaluate(req, conn, project, options);
    const sel = info.selection;
    const pairs = sel ? sel.pairs : [];
    const profile = cofold.foldProfile(options, info.settings);
    const estimate = sel && pairs.length > 0 && !sel.tooMany
      ? estimateRun({
        samples: await loadSamples(conn, 'fold'),
        profile,
        complexes: cofold.describeLengths(pairs.map(p => p.lenA + (p.lenB || 0))),
        slots: info.settings.cofold_max_parallel,
        unitsPerJob: 1
      })
      : null;

    // The script and list file of the first complex, so the user can see what
    // will be run before starting.
    let preview = null;
    if (pairs.length > 0 && info.workspace && info.workspace.active) {
      const { email } = await getRequestContext(coreApi, req);
      const dir = path.join(projectDir(info.workspace.path, project.project_number), PREDICTIONS_DIRNAME, 'run-N', 'job-N');
      preview = cofold.buildFoldFiles({
        slug: `ap-P${project.project_number}-fold-N`,
        settings: info.settings,
        email,
        options,
        pair: pairs[0],
        featuresDir: featuresDir(info.workspace.path, project.project_number),
        outputDir: path.join(dir, 'output'),
        cacheDir: jaxCacheDir(info.workspace.path, project.project_number)
      });
    }
    res.json({
      problems: info.problems,
      mode: project.mode,
      selected: info.selected,
      alreadyDone: sel ? sel.alreadyDone : 0,
      oversize: sel ? sel.oversize : 0,
      limitAA: info.settings.warn_max_complex_aa,
      toRun: sel && !sel.tooMany ? pairs.length : 0,
      maxParallel: info.settings.cofold_max_parallel,
      baits: project.mode === 'pulldown' ? info.rows.filter(r => r.role === 'bait').map(r => ({ name: r.name, length: r.length })) : [],
      preview: pairs.slice(0, PREVIEW_PAIRS).map(p => ({ bait: p.bait.name, cand: p.cand ? p.cand.name : null, lenA: p.lenA, lenB: p.lenB })),
      features: { missing: info.missing.length, names: info.missing.slice(0, MISSING_LISTED) },
      resources: {
        partition: info.settings.fold_partition || null,
        gres: info.settings.fold_gres || null,
        cpus: info.settings.fold_cpus_per_task,
        mem: info.settings.fold_mem,
        time: info.settings.fold_time
      },
      scripts: preview,
      profile,
      estimate,
      busy: await hasUnfinished(conn, project)
    });
  }));

  // POST /api/alphapulldown/projects/:id/cofold/runs - the options of the plan
  router.post('/projects/:id/cofold/runs', auth, withConn('Failed to start the prediction run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const { errors, options } = cofold.normaliseOptions(req.body);
    if (errors.length > 0) throw httpError(400, errors[0]);
    const info = await evaluate(req, conn, project, options);
    if (info.problems.length > 0) throw httpError(400, info.problems[0]);
    const pairs = info.selection.pairs;
    if (pairs.length === 0) throw httpError(400, 'Every complex in this selection has already been predicted (or is over the size limit).');
    if (await hasUnfinished(conn, project)) throw httpError(409, 'Complexes of this project are still queued or running. Wait for them or cancel that run first.');

    const profile = cofold.foldProfile(options, info.settings);
    const insert = await conn.query(
      `INSERT INTO alphapulldown_cofold_runs
         (project_id, owner_id, total, max_parallel, model_seeds, diffusion_samples, num_recycles, gpu_count, method, hardware)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [project.id, req.user.id, pairs.length, info.settings.cofold_max_parallel, options.seeds, options.samples,
        options.recycles, profile.method, profile.hardware]
    );
    const runId = Number(insert.insertId);
    try {
      for (const part of chunks(pairs, INSERT_CHUNK)) {
        await conn.batch(
          'INSERT INTO alphapulldown_cofold_items (run_id, project_id, bait_name, cand_name, len_a, len_b) VALUES (?, ?, ?, ?, ?, ?)',
          part.map(p => [runId, project.id, p.bait.name, p.cand ? p.cand.name : null, p.lenA, p.lenB])
        );
      }
    } catch (err) {
      await conn.query('DELETE FROM alphapulldown_cofold_items WHERE run_id = ?', [runId]);
      await conn.query('DELETE FROM alphapulldown_cofold_runs WHERE id = ?', [runId]);
      throw err;
    }
    res.status(201).json({ id: runId, total: pairs.length });
  }));

  async function countsFor(conn, runId) {
    const rows = await conn.query('SELECT state, COUNT(*) AS n FROM alphapulldown_cofold_items WHERE run_id = ? GROUP BY state', [runId]);
    const counts = emptyCounts();
    rows.forEach(r => {
      const n = Number(r.n);
      counts[cofold.stateGroup(r.state)] += n;
      counts.total += n;
    });
    return counts;
  }

  // Refreshes the jobs already submitted from Slurm's status, a few at a
  // time. A job the Slurm module no longer knows is closed as failed so it
  // cannot hold a slot forever.
  async function refreshInFlight(conn, req, run, deadline) {
    const rows = await conn.query(
      `SELECT * FROM alphapulldown_cofold_items WHERE run_id = ? AND slurm_job_id IS NOT NULL
       ORDER BY checked_at IS NOT NULL, checked_at, id`,
      [run.id]
    );
    const open = rows.filter(r => !cofold.isFinishedState(r.state)).slice(0, STATUS_REFRESHES_PER_SYNC);
    let statusError = null;
    for (const part of chunks(open, 5)) {
      if (Date.now() > deadline) break;
      const errors = await Promise.all(part.map(async item => {
        const status = await slurm.getJobStatus(coreApi, req.headers.authorization, item.slurm_job_id);
        if (!status.success) {
          if (status.status === 404) {
            await conn.query(
              "UPDATE alphapulldown_cofold_items SET state = 'FAILED', last_error = ?, checked_at = NOW(), ended_at = COALESCE(ended_at, NOW()) WHERE id = ?",
              ['The Slurm module no longer knows this job.', item.id]
            );
            return null;
          }
          await conn.query('UPDATE alphapulldown_cofold_items SET checked_at = NOW() WHERE id = ?', [item.id]);
          return status.error || 'Slurm status unavailable';
        }
        await conn.query(
          `UPDATE alphapulldown_cofold_items SET state = ?, slurm_submitted_at = ?, started_at = ?, ended_at = ?, checked_at = NOW() WHERE id = ?`,
          [
            String(status.state || item.state).slice(0, 30),
            toDate(status.submittedAt) || item.slurm_submitted_at,
            toDate(status.startedAt) || item.started_at,
            toDate(status.endedAt) || item.ended_at,
            item.id
          ]
        );
        return null;
      }));
      statusError = errors.find(Boolean) || statusError;
    }
    return statusError;
  }

  // Finished jobs copy their timings into the speed database - once each.
  // The marker is claimed per job first, so two requests at the same moment
  // cannot both ingest; if recording then fails the claims are released.
  async function ingestFinished(conn, run) {
    const rows = (await conn.query(
      'SELECT * FROM alphapulldown_cofold_items WHERE run_id = ? AND speed_ingested_at IS NULL AND slurm_job_id IS NOT NULL',
      [run.id]
    )).filter(r => cofold.isFinishedState(r.state));
    const claimed = [];
    for (const row of rows) {
      const result = await conn.query('UPDATE alphapulldown_cofold_items SET speed_ingested_at = NOW() WHERE id = ? AND speed_ingested_at IS NULL', [row.id]);
      if (result.affectedRows === 1) claimed.push(row);
    }
    if (claimed.length === 0) return 0;
    try {
      return await recordSamples(conn, cofold.samplesFromItems(claimed.map(toSampleItem), { method: run.method, hardware: run.hardware }));
    } catch (err) {
      for (const part of chunks(claimed.map(r => r.id), INSERT_CHUNK)) {
        await conn.query(`UPDATE alphapulldown_cofold_items SET speed_ingested_at = NULL WHERE id IN (${part.map(() => '?').join(',')})`, part);
      }
      throw err;
    }
  }

  // Reads the scores of jobs that completed, once each, so the Results tab can
  // sort them in SQL. A job whose summary file is not there yet is tried again
  // on the next sync (a network file system can lag) until it has been over for
  // a few minutes, then it is closed without scores.
  async function scoreCompleted(conn, project, run, workspace, deadline) {
    if (!workspace.active) return 0;
    const rows = await conn.query(
      "SELECT * FROM alphapulldown_cofold_items WHERE run_id = ? AND state LIKE 'COMPLETED%' AND scored_at IS NULL ORDER BY id LIMIT ?",
      [run.id, SCORES_PER_SYNC]
    );
    let scored = 0;
    for (const item of rows) {
      if (Date.now() > deadline) break;
      let found = null;
      try {
        found = await readJobScores(predictionJobDir(workspace.path, project.project_number, run.id, item.id));
      } catch (err) {
        found = null;
      }
      const endedAgo = item.ended_at ? (Date.now() - new Date(item.ended_at).getTime()) / 60000 : Infinity;
      if (found) {
        await conn.query(
          `UPDATE alphapulldown_cofold_items
             SET iptm = ?, ptm = ?, ranking_score = ?, interface_pae_min = ?, has_clash = ?, scored_at = NOW() WHERE id = ?`,
          [found.iptm, found.ptm, found.rankingScore, found.interfacePaeMin, found.hasClash, item.id]
        );
        scored += 1;
      } else if (endedAgo > SCORE_GIVE_UP_MINUTES) {
        await conn.query('UPDATE alphapulldown_cofold_items SET scored_at = NOW() WHERE id = ?', [item.id]);
      }
    }
    return scored;
  }

  // Writes one complex's folder (list file, sbatch script) and submits it.
  async function submitOne(req, project, workspace, settings, options, item, pair) {
    const dir = predictionJobDir(workspace.path, project.project_number, item.run_id, item.id);
    const slug = `ap-P${project.project_number}-fold-${item.id}`;
    const { email } = await getRequestContext(coreApi, req);
    const files = cofold.buildFoldFiles({
      slug,
      settings,
      email,
      options,
      pair,
      featuresDir: featuresDir(workspace.path, project.project_number),
      outputDir: path.join(dir, 'output'),
      cacheDir: jaxCacheDir(workspace.path, project.project_number)
    });
    // A retry starts from nothing: AlphaFold 3 will not write into a folder
    // it already filled.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, { encoding: 'utf8', mode: name.endsWith('.sh') ? 0o755 : 0o644 });
    }
    return slurm.submitJob(coreApi, req.headers.authorization, { workDir: dir, jobName: slug });
  }

  // Submits queued complexes while fewer than max_parallel are in flight. Stops
  // at the first failure (so a missing Slurm module is one error, not hundreds)
  // and reports it; a complex that fails three times is closed as SUBMIT_FAILED.
  async function submitQueued(conn, req, run, project, workspace, deadline) {
    await conn.query(
      `UPDATE alphapulldown_cofold_items SET state = 'QUEUED'
       WHERE run_id = ? AND state = 'SUBMITTING' AND slurm_job_id IS NULL AND claimed_at < NOW() - INTERVAL ${STALE_CLAIM_MINUTES} MINUTE`,
      [run.id]
    );
    const counts = await countsFor(conn, run.id);
    const slots = Math.max(0, run.max_parallel - counts.running);
    const want = Math.min(slots, SUBMITS_PER_SYNC, counts.queued);
    if (want === 0) return { submitted: 0, error: null };
    if (!workspace.active) return { submitted: 0, error: 'Workspace storage is not available for your account, so no job can be written.' };

    const queued = await conn.query(
      "SELECT * FROM alphapulldown_cofold_items WHERE run_id = ? AND state = 'QUEUED' ORDER BY id LIMIT ?",
      [run.id, want]
    );
    const rows = await projectRows(conn, project);
    const byRole = new Map(rows.map(r => [`${r.role}\u0000${r.name}`, r]));
    const settings = await loadSettings(conn, req.user.id);
    const options = optionsOf(run);
    let submitted = 0;

    for (const item of queued) {
      if (Date.now() > deadline) break;
      const claim = await conn.query(
        "UPDATE alphapulldown_cofold_items SET state = 'SUBMITTING', claimed_at = NOW(), attempts = attempts + 1 WHERE id = ? AND state = 'QUEUED'",
        [item.id]
      );
      if (claim.affectedRows !== 1) continue;

      const baitRole = project.mode === 'pulldown' ? 'bait' : 'all';
      const candRole = project.mode === 'pulldown' ? 'candidate' : 'all';
      const bait = byRole.get(`${baitRole}\u0000${item.bait_name}`);
      const cand = item.cand_name === null ? null : byRole.get(`${candRole}\u0000${item.cand_name}`);
      if (!bait || (item.cand_name !== null && !cand)) {
        await conn.query(
          "UPDATE alphapulldown_cofold_items SET state = 'SUBMIT_FAILED', last_error = ? WHERE id = ?",
          ['A protein of this complex was removed from the project.', item.id]
        );
        continue;
      }
      const pair = {
        bait: { name: bait.name, length: bait.length, copies: bait.copies > 0 ? bait.copies : 1, sequence: bait.sequence },
        cand: cand ? { name: cand.name, length: cand.length, copies: cand.copies > 0 ? cand.copies : 1, sequence: cand.sequence } : null
      };
      let created;
      try {
        created = await submitOne(req, project, workspace, settings, options, item, pair);
      } catch (err) {
        created = { success: false, error: `Could not write the job's files: ${err.message}` };
      }

      if (!created.success) {
        const message = created.status === 403
          ? 'You are not a registered Slurm user, so the job could not be submitted.'
          : String(created.error).slice(0, 400);
        const exhausted = item.attempts + 1 >= cofold.MAX_SUBMIT_ATTEMPTS;
        await conn.query(
          'UPDATE alphapulldown_cofold_items SET state = ?, last_error = ? WHERE id = ?',
          [exhausted ? 'SUBMIT_FAILED' : 'QUEUED', message, item.id]
        );
        return { submitted, error: message };
      }
      await conn.query(
        "UPDATE alphapulldown_cofold_items SET state = 'PENDING', slurm_job_id = ?, last_error = NULL WHERE id = ?",
        [String(created.jobId), item.id]
      );
      submitted += 1;
    }
    return { submitted, error: null };
  }

  // Brings one run up to date. Returns what the page needs to know.
  async function syncRun(conn, req, run, project, workspace) {
    const result = { statusError: null, submitError: null, ingestedNow: 0, busy: false };
    if (syncing.has(run.id)) return { ...result, busy: true };
    syncing.add(run.id);
    try {
      const deadline = Date.now() + SYNC_BUDGET_MS;
      result.statusError = await refreshInFlight(conn, req, run, deadline);
      result.ingestedNow = await ingestFinished(conn, run);
      await scoreCompleted(conn, project, run, workspace, deadline);
      if (!run.cancelled_at) {
        const submitted = await submitQueued(conn, req, run, project, workspace, deadline);
        result.submitError = submitted.error;
        result.submittedNow = submitted.submitted;
      }
    } finally {
      syncing.delete(run.id);
    }
    return result;
  }

  async function describeRun(conn, run, sync, samples) {
    const counts = await countsFor(conn, run.id);
    const waiting = !run.cancelled_at && counts.queued > 0;
    const active = counts.running > 0 || waiting;
    let remaining = null;
    if (active) {
      const rows = (await conn.query('SELECT state, len_a, len_b FROM alphapulldown_cofold_items WHERE run_id = ?', [run.id]))
        .filter(r => !cofold.isFinishedState(r.state));
      remaining = estimateRun({
        samples,
        profile: { method: run.method, hardware: run.hardware },
        complexes: cofold.describeLengths(rows.map(r => r.len_a + (r.len_b || 0))),
        slots: run.max_parallel,
        unitsPerJob: 1
      });
    }
    return {
      id: Number(run.id),
      createdAt: run.created_at,
      cancelledAt: run.cancelled_at,
      maxParallel: run.max_parallel,
      options: optionsOf(run),
      counts,
      active,
      waiting,
      remaining,
      statusError: sync ? sync.statusError : null,
      submitError: sync ? sync.submitError : null,
      submittedNow: sync ? sync.submittedNow || 0 : 0,
      // more to do right away: queued complexes, free slots and no error
      more: !!sync && waiting && !sync.submitError && counts.running < run.max_parallel
    };
  }

  // GET /api/alphapulldown/projects/:id/cofold/runs - newest first, each brought up to date
  router.get('/projects/:id/cofold/runs', auth, withConn('Failed to list prediction runs', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    const rows = await conn.query(
      'SELECT * FROM alphapulldown_cofold_runs WHERE project_id = ? AND owner_id = ? ORDER BY id DESC LIMIT ?',
      [project.id, req.user.id, MAX_LISTED_RUNS]
    );
    let ingestedNow = 0;
    const runs = [];
    for (const row of rows) {
      const sync = await syncRun(conn, req, row, project, workspace);
      ingestedNow += sync.ingestedNow;
      runs.push({ row, sync });
    }
    const samples = runs.length > 0 ? await loadSamples(conn, 'fold') : [];
    const out = [];
    for (const { row, sync } of runs) out.push(await describeRun(conn, row, sync, samples));
    res.json({ runs: out, ingestedNow });
  }));

  // GET /api/alphapulldown/projects/:id/cofold/runs/:runId/items?group=&offset=&limit=
  // One page of a run's complexes, optionally one progress group only.
  router.get('/projects/:id/cofold/runs/:runId/items', auth, withConn('Failed to read the complexes', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const run = await requireRun(conn, req, project);
    const group = req.query.group;
    if (group !== undefined && !['queued', 'running', 'done', 'failed', 'cancelled'].includes(group)) {
      throw httpError(400, 'group must be queued, running, done, failed or cancelled');
    }
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(ITEMS_PAGE, Math.max(1, Number.parseInt(req.query.limit, 10) || ITEMS_PAGE));
    const all = (await conn.query('SELECT * FROM alphapulldown_cofold_items WHERE run_id = ? ORDER BY id', [run.id]))
      .filter(r => !group || cofold.stateGroup(r.state) === group);
    res.json({
      total: all.length,
      offset,
      items: all.slice(offset, offset + limit).map(r => ({
        id: Number(r.id),
        bait: r.bait_name,
        cand: r.cand_name,
        lenA: r.len_a,
        lenB: r.len_b,
        state: r.state,
        group: cofold.stateGroup(r.state),
        slurmJobId: r.slurm_job_id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        attempts: r.attempts,
        error: r.last_error
      }))
    });
  }));

  // GET /api/alphapulldown/projects/:id/cofold/runs/:runId/items/:itemId/log?file=slurm.out|slurm.err
  // The last 64 KB of one log file of a job, as { text, truncated }.
  router.get('/projects/:id/cofold/runs/:runId/items/:itemId/log', auth, withConn('Failed to read the log', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const run = await requireRun(conn, req, project);
    if (!LOG_FILES.includes(req.query.file)) throw httpError(400, 'file must be slurm.out or slurm.err');
    const rows = await conn.query('SELECT id FROM alphapulldown_cofold_items WHERE id = ? AND run_id = ?', [req.params.itemId, run.id]);
    if (!rows[0]) throw httpError(404, 'Job not found');
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    if (!workspace.active) throw httpError(503, 'Workspace storage is not available for this user.');
    const file = path.join(predictionJobDir(workspace.path, project.project_number, run.id, rows[0].id), req.query.file);

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

  // GET /api/alphapulldown/projects/:id/cofold/runs/:runId - one run, brought up to date
  router.get('/projects/:id/cofold/runs/:runId', auth, withConn('Failed to read the prediction run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    const run = await requireRun(conn, req, project);
    const sync = await syncRun(conn, req, run, project, workspace);
    res.json({ ...(await describeRun(conn, run, sync, await loadSamples(conn, 'fold'))), ingestedNow: sync.ingestedNow });
  }));

  // POST /api/alphapulldown/projects/:id/cofold/runs/:runId/cancel - queued
  // complexes are dropped; submitted ones are cancelled in Slurm.
  router.post('/projects/:id/cofold/runs/:runId/cancel', auth, withConn('Failed to cancel the run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const run = await requireRun(conn, req, project);
    const dropped = await conn.query("UPDATE alphapulldown_cofold_items SET state = 'CANCELLED', ended_at = NOW() WHERE run_id = ? AND state = 'QUEUED'", [run.id]);
    await conn.query('UPDATE alphapulldown_cofold_runs SET cancelled_at = COALESCE(cancelled_at, NOW()) WHERE id = ?', [run.id]);

    const open = (await conn.query('SELECT * FROM alphapulldown_cofold_items WHERE run_id = ?', [run.id]))
      .filter(r => cofold.isInFlightState(r.state));
    const outcomes = [];
    for (const part of chunks(open, 5)) {
      outcomes.push(...await Promise.all(part.map(async item => {
        if (!item.slurm_job_id) return false;
        const result = await slurm.cancelJob(coreApi, req.headers.authorization, item.slurm_job_id);
        return result.success;
      })));
    }
    const cancelled = outcomes.filter(Boolean).length;
    const uncancellable = outcomes.length - cancelled;
    res.json({ success: true, dropped: Number(dropped.affectedRows), cancelled, uncancellable });
  }));

  // POST /api/alphapulldown/projects/:id/cofold/runs/:runId/retry - complexes that
  // failed (or could not be submitted) go back in the queue.
  router.post('/projects/:id/cofold/runs/:runId/retry', auth, withConn('Failed to retry the complexes', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const run = await requireRun(conn, req, project);
    if (run.cancelled_at) throw httpError(409, 'This run was cancelled. Start a new run instead.');
    const failed = (await conn.query('SELECT id, state FROM alphapulldown_cofold_items WHERE run_id = ?', [run.id]))
      .filter(r => cofold.stateGroup(r.state) === 'failed');
    for (const part of chunks(failed.map(r => r.id), INSERT_CHUNK)) {
      await conn.query(
        `UPDATE alphapulldown_cofold_items
           SET state = 'QUEUED', attempts = 0, last_error = NULL, slurm_job_id = NULL,
               claimed_at = NULL, checked_at = NULL, slurm_submitted_at = NULL, started_at = NULL, ended_at = NULL,
               speed_ingested_at = NULL, iptm = NULL, ptm = NULL, ranking_score = NULL, interface_pae_min = NULL,
               has_clash = NULL, scored_at = NULL
         WHERE id IN (${part.map(() => '?').join(',')})`,
        part
      );
    }
    res.json({ success: true, requeued: failed.length });
  }));

  // DELETE /api/alphapulldown/projects/:id/cofold/runs/:runId - the record
  // only, once nothing is queued or in flight. The jobs' folders (and the
  // structures in them) stay in the workspace.
  router.delete('/projects/:id/cofold/runs/:runId', auth, withConn('Failed to delete the run', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const run = await requireRun(conn, req, project);
    const states = await conn.query('SELECT DISTINCT state FROM alphapulldown_cofold_items WHERE run_id = ?', [run.id]);
    if (states.some(r => !cofold.isFinishedState(r.state))) throw httpError(409, 'Cancel the run before deleting it.');
    await conn.query('DELETE FROM alphapulldown_cofold_items WHERE run_id = ?', [run.id]);
    await conn.query('DELETE FROM alphapulldown_cofold_runs WHERE id = ?', [run.id]);
    res.json({ success: true });
  }));

  return router;
};
