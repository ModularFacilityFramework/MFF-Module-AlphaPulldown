// The size and time figures of a project (:id is a Science project). Projects
// themselves are Science's: they are listed, created and shared there and
// picked with core's project picker; this module has no routes for them.
const express = require('express');
const { computeStats, describeComplexes, describeProteins } = require('../services/sequenceStats');
const { estimateRun } = require('../services/speedEstimator');
const { loadSamples } = require('../services/speedRecorder');
const { msaProfile } = require('../services/speedProfiles');
const science = require('../services/scienceProjects');
const { collectItems } = require('../services/scienceMove');
const { ITEM_TYPES } = require('../services/projectItems');
const { nameLookup } = require('../services/people');
const { loadSettings } = require('../services/settingsStore');

module.exports = function buildRouter(coreApi) {
  const router = express.Router();

  // The numbers for the stats strip: sizes, plus an estimate for each stage
  // from the anonymised speed samples (see services/speedEstimator.js). The
  // MSA estimate uses the caller's own Setup values. The co-folding options
  // are chosen per run in the co-folding stage, so the strip uses the labels
  // of this project's latest run (estimates.foldBasis 'last-run'); a project
  // that has not folded yet learns from every fold sample ('all').
  async function statsFor(conn, project, ownerId) {
    const [rows, settings, lastRun] = await Promise.all([
      conn.query('SELECT role, name, length, copies FROM alphapulldown_project_sequences WHERE project_id = ?', [project.id]),
      loadSettings(conn, ownerId),
      conn.query('SELECT method, hardware, gpu_count FROM alphapulldown_cofold_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', [project.id])
    ]);
    const foldProfile = lastRun.length > 0 && lastRun[0].method ? { method: lastRun[0].method, hardware: lastRun[0].hardware } : {};
    const stats = computeStats(rows, { mode: project.mode, limitAA: settings.warn_max_complex_aa });

    const [msaSamples, foldSamples] = await Promise.all([loadSamples(conn, 'msa'), loadSamples(conn, 'fold')]);
    stats.estimates = {
      msa: estimateRun({
        samples: msaSamples,
        profile: msaProfile(settings),
        complexes: describeProteins(rows),
        slots: settings.msa_array_throttle,
        unitsPerJob: settings.msa_cpus_per_task
      }),
      fold: estimateRun({
        samples: foldSamples,
        profile: foldProfile,
        complexes: describeComplexes(stats.mode, rows),
        slots: settings.cofold_max_parallel,
        unitsPerJob: foldProfile.method ? lastRun[0].gpu_count : 1
      }),
      foldBasis: foldProfile.method ? 'last-run' : 'all'
    };
    return stats;
  }

  // GET /api/alphapulldown/projects/:id/stats - the numbers in the stats strip
  router.get('/projects/:id/stats', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const project = await science.openOwnLink(coreApi, conn, req);
      res.json(await statsFor(conn, project, req.user.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to compute project stats', message: err.message });
    } finally {
      conn.release();
    }
  });

  // GET /api/alphapulldown/projects/:id/runs - the feature and co-folding
  // runs of a Science project, whoever started them, as last seen (nothing is
  // refreshed or started here). Under the Project template: the caller's runs
  // that have no project (staff see everyone's).
  router.get('/projects/:id/runs', coreApi.authenticateToken, async (req, res) => {
    let conn;
    try {
      const access = await science.requireAccess(coreApi, req.user, req.params.id);
      conn = await coreApi.pool.getConnection();
      let found = [];
      if (access.isTemplate) {
        const old = science.oldWork(req.user);
        found = await collectItems(conn, old.where, old.params);
      } else {
        const links = await science.linksFor(conn, access.id);
        if (links.length > 0) found = await collectItems(conn, `project_id IN (${links.map(() => '?').join(', ')})`, links.map(l => l.id));
      }
      const name = await nameLookup(coreApi);
      res.json({
        runs: found.filter(item => item.type !== ITEM_TYPES.target)
          .map(item => ({ kind: item.type, id: item.id, title: item.title, state: item.status, ownerName: name(item.ownerId), createdAt: item.createdAt }))
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to list the runs', message: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
