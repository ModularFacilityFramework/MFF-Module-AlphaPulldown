// Module entry point. mff-core's auto-loader (App_backend/src/core/services/moduleLoader.js)
// requires this file and calls register(coreApi) once at startup - see
// docs/MFF-Core_module-core-api.md for the full coreApi contract. This file
// is the ONLY place this module talks to core.
const express = require('express');
const manifest = require('../module.manifest.json');
const createPool = require('./config/database');
const scienceMove = require('./services/scienceMove');
const buildSettingsRouter = require('./routes/settingsRoutes');
const buildProjectRouter = require('./routes/projectRoutes');
const buildSequenceRouter = require('./routes/sequenceRoutes');
const buildMsaRouter = require('./routes/msaRoutes');
const buildCofoldRouter = require('./routes/cofoldRoutes');
const buildLibraryRouter = require('./routes/libraryRoutes');
const buildTargetRouter = require('./routes/targetRoutes');
const buildProvenanceRouter = require('./routes/provenanceRoutes');
const buildSpeedRouter = require('./routes/speedRoutes');
const buildPageAccessRouter = require('./routes/pageAccessRoutes');

module.exports = function register(coreApi) {
  // createPool needs coreApi.getModuleConfig(), which is only bound to this
  // module's own id once register() is actually called - can't build the
  // pool at require() time like before (see config/database.js).
  const moduleApi = { ...coreApi, pool: createPool(coreApi) };
  const router = express.Router();
  router.use(buildSettingsRouter(moduleApi));
  router.use(buildProjectRouter(moduleApi));
  router.use(buildLibraryRouter(moduleApi));
  router.use(buildTargetRouter(moduleApi));
  router.use(buildProvenanceRouter(moduleApi));
  router.use(buildSequenceRouter(moduleApi));
  router.use(buildMsaRouter(moduleApi));
  router.use(buildCofoldRouter(moduleApi));
  router.use(buildSpeedRouter(moduleApi));
  router.use(buildPageAccessRouter(moduleApi));
  // Old projects of this module are moved into Science in the background.
  scienceMove.start(moduleApi);
  return {
    router,
    moduleId: manifest.id,
    label: manifest.label,
    version: manifest.version
  };
};
