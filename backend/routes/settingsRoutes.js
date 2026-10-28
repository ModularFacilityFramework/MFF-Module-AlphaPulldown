// Everything this module needs from core comes through coreApi (passed into
// register() in ../index.js and down to here) - never via a relative require
// into an mff-core checkout. See docs/MFF-Core_module-core-api.md for the full contract.
const express = require('express');
const { getRequestContext } = require('../services/requestContext');

// Used whenever a user has no alphapulldown_settings row yet, so GET always
// returns something PUT can upsert without the frontend special-casing "no
// settings saved yet" vs "existing settings". Mirrors the column DEFAULTs in
// backend/db/schema.sql. data_dir and msa_partition are empty on purpose:
// they are facts about the user's cluster that this module cannot know.
const DEFAULT_SETTINGS = {
  slurm_mail_type: 'BEGIN,END,FAIL',
  env_manager: 'micromamba',
  env_name: 'alphapulldown',
  data_dir: '',
  msa_use_mmseqs2: 0,
  max_template_date: '2050-01-01',
  msa_partition: '',
  msa_cpus_per_task: 8,
  msa_mem: '64G',
  msa_time: '10:00:00',
  msa_array_throttle: 20,
  cofold_max_parallel: 20,
  warn_max_complex_aa: 5000
};
const SETTINGS_FIELDS = Object.keys(DEFAULT_SETTINGS);

// Every string below is written verbatim into a generated sbatch script, so
// each one must match a strict pattern - a newline or a shell metacharacter
// in a stored setting would otherwise be a script-injection path.
const ENV_MANAGERS = ['micromamba', 'conda'];
const PATTERNS = {
  slurm_mail_type: /^[A-Z_,]{0,50}$/,
  env_name: /^[\w.-]{1,255}$/,
  data_dir: /^(\/[\w./-]{0,499})?$/,
  max_template_date: /^\d{4}-\d{2}-\d{2}$/,
  msa_partition: /^[\w.,-]{0,100}$/,
  msa_mem: /^\d{1,6}[KMGT]?$/i,
  msa_time: /^(\d{1,3}-)?\d{1,3}(:\d{2}){0,2}$/
};
const INTEGER_RANGES = {
  msa_cpus_per_task: [1, 512],
  msa_array_throttle: [1, 1000],
  cofold_max_parallel: [1, 1000],
  warn_max_complex_aa: [100, 100000]
};

// Returns { values } with every field either the caller's own validated
// value or DEFAULT_SETTINGS' fallback, or { error } naming the first bad field.
function normalizeSettings(body) {
  const source = body || {};
  const values = {};
  for (const field of SETTINGS_FIELDS) {
    values[field] = source[field] !== undefined ? source[field] : DEFAULT_SETTINGS[field];
  }

  if (!ENV_MANAGERS.includes(values.env_manager)) return { error: 'env_manager must be micromamba or conda' };
  values.msa_use_mmseqs2 = values.msa_use_mmseqs2 ? 1 : 0;

  for (const [field, pattern] of Object.entries(PATTERNS)) {
    if (typeof values[field] !== 'string' || !pattern.test(values[field])) return { error: `${field} has an invalid value` };
  }
  for (const [field, [min, max]] of Object.entries(INTEGER_RANGES)) {
    const n = Number(values[field]);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${field} must be a whole number between ${min} and ${max}` };
    values[field] = n;
  }
  return { values };
}

function buildRouter(coreApi) {
  const router = express.Router();

  async function loadSettings(conn, ownerId) {
    const rows = await conn.query('SELECT * FROM alphapulldown_settings WHERE owner_id = ?', [ownerId]);
    return rows[0] || { ...DEFAULT_SETTINGS, owner_id: ownerId };
  }

  // The settings row plus what the Setup tab shows read-only (account,
  // email, workspace) - all of it from coreApi, none of it stored here.
  async function buildResponse(req, settings) {
    const { account, email, workspace } = await getRequestContext(coreApi, req);
    return { ...settings, account, email, workspace };
  }

  // GET /api/alphapulldown/settings - the caller's own settings
  router.get('/settings', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      res.json(await buildResponse(req, await loadSettings(conn, req.user.id)));
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch settings', message: err.message });
    } finally {
      conn.release();
    }
  });

  // PUT /api/alphapulldown/settings - upsert on owner_id
  router.put('/settings', coreApi.authenticateToken, async (req, res) => {
    const { values, error } = normalizeSettings(req.body);
    if (error) return res.status(400).json({ error });

    const conn = await coreApi.pool.getConnection();
    try {
      const columns = ['owner_id', ...SETTINGS_FIELDS];
      const placeholders = columns.map(() => '?').join(', ');
      const updateClause = SETTINGS_FIELDS.map(f => `${f} = VALUES(${f})`).join(', ');
      await conn.query(
        `INSERT INTO alphapulldown_settings (${columns.join(', ')}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateClause}`,
        [req.user.id, ...SETTINGS_FIELDS.map(f => values[f])]
      );
      res.json(await buildResponse(req, await loadSettings(conn, req.user.id)));
    } catch (err) {
      res.status(500).json({ error: 'Failed to save settings', message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
}

module.exports = buildRouter;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.normalizeSettings = normalizeSettings;
