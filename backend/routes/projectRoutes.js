// Projects: one bait/candidate set that ties the Sequences, MSA and
// Co-folding tabs together. Every query is scoped to req.user.id - a user
// only ever sees their own projects. Everything this module needs from core
// comes through coreApi (see docs/MFF-Core_module-core-api.md).
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { MODES, computeStats, describeComplexes, describeProteins } = require('../services/sequenceStats');
const { estimateRun } = require('../services/speedEstimator');
const { loadSamples } = require('../services/speedRecorder');
const { msaProfile } = require('../services/speedProfiles');
const { projectDir, isInside, MODULE_DIRNAME } = require('../services/projectPaths');
const { findProject } = require('../services/projectAccess');
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

  // GET /api/alphapulldown/projects - the caller's own projects, newest first
  router.get('/projects', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const rows = await conn.query(
        `SELECT p.id, p.project_number, p.name, p.mode, p.created_at,
                (SELECT COUNT(*) FROM alphapulldown_project_sequences s WHERE s.project_id = p.id) AS sequence_count
         FROM alphapulldown_projects p WHERE p.owner_id = ? ORDER BY p.created_at DESC, p.id DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list projects', message: err.message });
    } finally {
      conn.release();
    }
  });

  // POST /api/alphapulldown/projects - { name, mode }. project_number is the
  // owner's next sequential number; the unique key on (owner_id,
  // project_number) guards two simultaneous creates.
  router.post('/projects', coreApi.authenticateToken, async (req, res) => {
    const { name, mode } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255) {
      return res.status(400).json({ error: 'name is required (max 255 characters)' });
    }
    const projectMode = mode === undefined ? 'pulldown' : mode;
    if (!MODES.includes(projectMode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });

    const conn = await coreApi.pool.getConnection();
    try {
      const result = await conn.query(
        `INSERT INTO alphapulldown_projects (owner_id, project_number, name, mode)
         SELECT ?, COALESCE(MAX(project_number), 0) + 1, ?, ? FROM alphapulldown_projects WHERE owner_id = ?`,
        [req.user.id, name.trim(), projectMode, req.user.id]
      );
      res.status(201).json(await findProject(conn, result.insertId, req.user.id));
    } catch (err) {
      res.status(500).json({ error: 'Failed to create project', message: err.message });
    } finally {
      conn.release();
    }
  });

  // GET /api/alphapulldown/projects/:id/stats - the numbers in the stats strip
  router.get('/projects/:id/stats', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const project = await findProject(conn, req.params.id, req.user.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(await statsFor(conn, project, req.user.id));
    } catch (err) {
      res.status(500).json({ error: 'Failed to compute project stats', message: err.message });
    } finally {
      conn.release();
    }
  });

  // DELETE /api/alphapulldown/projects/:id - the project, its sequences and
  // (best effort) its folder in the user's workspace.
  router.delete('/projects/:id', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const project = await findProject(conn, req.params.id, req.user.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      await conn.beginTransaction();
      await conn.query('DELETE FROM alphapulldown_project_sequences WHERE project_id = ?', [project.id]);
      await conn.query('DELETE FROM alphapulldown_projects WHERE id = ?', [project.id]);
      await conn.commit();

      // The rows are gone either way; a folder that cannot be removed (no
      // workspace, permissions) is reported, not treated as a failed delete.
      let folderRemoved = false;
      const workspace = await coreApi.getUserWorkspacePath(req.user);
      if (workspace.active) {
        const dir = projectDir(workspace.path, project.project_number);
        if (isInside(path.join(workspace.path, MODULE_DIRNAME), dir)) {
          try {
            await fs.rm(dir, { recursive: true, force: true });
            folderRemoved = true;
          } catch (fsErr) {
            folderRemoved = false;
          }
        }
      }
      res.json({ success: true, folderRemoved });
    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: 'Failed to delete project', message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};
