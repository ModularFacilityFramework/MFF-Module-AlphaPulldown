// The staff speed-statistics view: a read-only summary of the anonymised
// speed samples (alphapulldown_speed_samples). There is deliberately no
// route that writes, edits or deletes a sample - only the module's own
// backend adds them (services/speedRecorder.js), from jobs it observed.
// Everything this module needs from core comes through coreApi (see
// docs/MFF-Core_module-core-api.md); staff means the same roles as the
// Page Access tab.
const express = require('express');
const { loadSamples, STAGES, OUTCOMES } = require('../services/speedRecorder');
const { ACTIVITY_DAYS, summariseSamples, describeLabels, lastDays } = require('../services/speedSummary');

module.exports = function buildRouter(coreApi) {
  const router = express.Router();

  // GET /api/alphapulldown/speed/summary
  //  totals: true counts per stage and outcome (the whole table)
  //  loaded: how many of each stage's newest samples the groups are built
  //          from (the estimator reads the same ones), so the view can say
  //          when the groups cover only part of the table
  //  groups: one entry per stage + method + hardware, as the estimator sees them
  //  activity: samples recorded per day for the last ACTIVITY_DAYS days
  router.get('/speed/summary', coreApi.authenticateToken, coreApi.checkRole(['developer', 'administrator']), async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [outcomeRows, spanRows, activityRows, ...loaded] = await Promise.all([
        conn.query('SELECT stage, outcome, COUNT(*) AS n FROM alphapulldown_speed_samples GROUP BY stage, outcome'),
        conn.query("SELECT DATE_FORMAT(MIN(sampled_on), '%Y-%m-%d') AS first_day, DATE_FORMAT(MAX(sampled_on), '%Y-%m-%d') AS last_day FROM alphapulldown_speed_samples"),
        conn.query(
          `SELECT DATE_FORMAT(sampled_on, '%Y-%m-%d') AS day, stage, COUNT(*) AS n FROM alphapulldown_speed_samples
           WHERE sampled_on > DATE_SUB(?, INTERVAL ? DAY) GROUP BY sampled_on, stage`,
          [today, ACTIVITY_DAYS]
        ),
        ...STAGES.map(stage => loadSamples(conn, stage))
      ]);

      const totals = {};
      STAGES.forEach(stage => {
        totals[stage] = { samples: 0 };
        OUTCOMES.forEach(outcome => { totals[stage][outcome] = 0; });
      });
      outcomeRows.forEach(r => {
        if (!totals[r.stage]) return;
        totals[r.stage][r.outcome] = Number(r.n);
        totals[r.stage].samples += Number(r.n);
      });

      // loadSamples rows are in the estimator's shape, which has no stage
      const samples = loaded.flatMap((rows, i) => rows.map(r => ({ ...r, stage: STAGES[i] })));
      const { groups, groupsOmitted } = summariseSamples(samples);
      res.json({
        totals,
        firstDay: spanRows[0].first_day,
        lastDay: spanRows[0].last_day,
        loaded: Object.fromEntries(STAGES.map((stage, i) => [stage, loaded[i].length])),
        groups: groups.map(g => ({ ...g, ...describeLabels(g.stage, g.method, g.hardware) })),
        groupsOmitted,
        activity: lastDays(activityRows.map(r => ({ day: r.day, stage: r.stage, n: Number(r.n) })), today)
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read the speed statistics', message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};
