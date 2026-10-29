// The caller's Setup values with the module's defaults filled in for
// anything not saved yet - what every route that builds a script or an
// estimate starts from.
const { DEFAULT_SETTINGS } = require('../routes/settingsRoutes');

async function loadSettings(conn, ownerId) {
  const rows = await conn.query('SELECT * FROM alphapulldown_settings WHERE owner_id = ?', [ownerId]);
  return { ...DEFAULT_SETTINGS, ...(rows[0] || {}) };
}

module.exports = { loadSettings };
