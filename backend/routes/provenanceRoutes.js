// The record behind a project's methods: the latest finished feature run and
// the latest prediction run, each with the proteome versions and feature
// sets it used, and the paragraph written from them. Everything is read from
// the runs' own stored provenance - nothing is looked up again - so the text
// stays true even after a library proteome is replaced by a newer release.
const express = require('express');
const provenance = require('../services/provenance');
const { makeHelpers } = require('../services/routeHelpers');

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (err) {
    return null;
  }
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();
  const auth = coreApi.authenticateToken;
  const { withConn, requireProject } = makeHelpers(coreApi);

  // GET /api/alphapulldown/projects/:id/provenance
  router.get('/projects/:id/provenance', auth, withConn('Failed to read the project record', async (req, res, conn) => {
    const project = await requireProject(conn, req);
    const features = await conn.query(
      "SELECT id, state, ended_at, provenance_json FROM alphapulldown_msa_runs WHERE project_id = ? AND owner_id = ? AND state LIKE 'COMPLETED%' AND provenance_json IS NOT NULL ORDER BY id DESC LIMIT 1",
      [project.id, req.user.id]
    );
    const folds = await conn.query(
      'SELECT id, created_at, provenance_json FROM alphapulldown_cofold_runs WHERE project_id = ? AND owner_id = ? AND provenance_json IS NOT NULL ORDER BY id DESC LIMIT 1',
      [project.id, req.user.id]
    );
    const feature = features[0] ? parse(features[0].provenance_json) : null;
    const cofold = folds[0] ? parse(folds[0].provenance_json) : null;
    const { text, missing } = provenance.methodsText({ feature, cofold });
    res.json({
      featureRun: features[0] ? { id: Number(features[0].id), endedAt: features[0].ended_at } : null,
      cofoldRun: folds[0] ? { id: Number(folds[0].id), createdAt: folds[0].created_at } : null,
      feature,
      cofold,
      methods: text,
      missing,
      citation: provenance.CITATION
    });
  }));

  return router;
};
