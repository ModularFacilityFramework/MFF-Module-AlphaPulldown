// The size and time figures of a project (:id is a Science project). Projects
// themselves are Science's: they are listed, created and shared there and
// picked with core's project picker; this module has no routes for them.
const express = require('express');
const { computeStats, describeComplexes, describeProteins } = require('../services/sequenceStats');
const { estimateRun } = require('../services/speedEstimator');
const { loadSamples } = require('../services/speedRecorder');
const { msaProfile } = require('../services/speedProfiles');
const { openOwnLink } = require('../services/scienceProjects');
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
      const project = await openOwnLink(coreApi, conn, req);
      res.json(await statsFor(conn, project, req.user.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to compute project stats', message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};
