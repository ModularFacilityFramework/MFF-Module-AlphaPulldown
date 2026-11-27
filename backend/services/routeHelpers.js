// Small helpers shared by the route files: a status-carrying error, a
// handler wrapper that owns the database connection, and the two lookups
// every project route starts with.
const { httpError } = require('./httpError');
const { openOwnLink } = require('./scienceProjects');

function makeHelpers(coreApi) {
  // Wraps a handler that needs a database connection: releases it, turns
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

  // :id is a Science project; returns the caller's link row in it (reading
  // needs read access, anything else write access).
  async function requireProject(conn, req) {
    return openOwnLink(coreApi, conn, req);
  }

  async function requireWorkspace(req) {
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    if (!workspace.active) throw httpError(503, 'Workspace storage is not available for this user.');
    return workspace;
  }

  return { withConn, requireProject, requireWorkspace };
}

module.exports = { httpError, makeHelpers };
