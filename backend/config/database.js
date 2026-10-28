const mariadb = require('mariadb');

// One .env in the entire system - App_backend/.env, owned by core - see
// docs/MFF-Core_env-policy.md, the authoritative statement of this rule.
// This module holds no .env of its own, reads no file, and never calls
// dotenv.config()/dotenv.parse() - database credentials come from
// coreApi.getModuleConfig() exactly like any other config value (that
// function now explicitly covers DB credentials too, see the policy doc's
// "What a module MUST do" section). coreApi.getModuleConfig() is bound to
// this module's own id before register() ever runs, so it's only callable
// from inside register(coreApi) (backend/index.js) - that's why this file
// exports a function taking coreApi, not a pool built at require() time.
module.exports = function createPool(coreApi) {
  const cfg = coreApi.getModuleConfig();
  return mariadb.createPool({
    host: cfg.DB_HOST || '127.0.0.1',
    user: cfg.DB_USER,
    password: cfg.DB_PASSWORD,
    database: cfg.DB_NAME,
    connectionLimit: Number(cfg.DB_CONNECTION_LIMIT) || 5,
    bigIntAsNumber: true,
    insertIdAsNumber: true
  });
};
