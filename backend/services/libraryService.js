// Database-side helpers of the shared library, used by the library routes,
// the sequence routes and the feature/prediction routes: the one config row,
// proteome versions, and the feature set a protein is built into. The files
// themselves are libraryStore.js; names and layout are libraryPaths.js.
const paths = require('./libraryPaths');
const store = require('./libraryStore');

const DEFAULT_TAG = 'v1';

async function loadConfig(conn) {
  const rows = await conn.query('SELECT * FROM alphapulldown_library_config WHERE id = 1');
  const row = rows[0];
  return {
    libraryDir: row ? row.library_dir : '',
    featureSetTag: row ? row.feature_set_tag : DEFAULT_TAG,
    configured: !!(row && row.library_dir),
    updatedAt: row ? row.updated_at : null
  };
}

async function saveConfig(conn, { libraryDir, featureSetTag }, userId) {
  await conn.query(
    `INSERT INTO alphapulldown_library_config (id, library_dir, feature_set_tag, updated_by) VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE library_dir = VALUES(library_dir), feature_set_tag = VALUES(feature_set_tag), updated_by = VALUES(updated_by)`,
    [libraryDir, featureSetTag, userId]
  );
}

function versionOf(row) {
  return { upid: row.upid, release: row.release_name, subset: row.subset };
}

async function insertProteome(conn, metadata, userId) {
  const uni = metadata.uniprot || {};
  await conn.query(
    `INSERT INTO alphapulldown_library_proteomes
       (upid, release_name, release_date, subset, organism, tax_id, proteome_type, entries, bytes, sha256, source, metadata_json, downloaded_at, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      metadata.upid, uni.release, uni.releaseDate || '', metadata.subset, metadata.organism || '', metadata.taxId || null,
      metadata.proteomeType || '', uni.entries || 0, (metadata.file && metadata.file.bytes) || 0, (metadata.file && metadata.file.sha256) || '',
      metadata.source || '', JSON.stringify(metadata), new Date(metadata.downloadedAt), userId || null
    ]
  );
}

async function findProteome(conn, id) {
  const rows = await conn.query('SELECT * FROM alphapulldown_library_proteomes WHERE id = ?', [id]);
  return rows[0] || null;
}

// The feature set of one proteome version under the caller's build
// configuration, created (row and folder) when it does not exist yet.
// settings: the caller's Setup values. Returns { row, dir }.
async function ensureSet(conn, config, proteome, settings, userId) {
  const build = { format: paths.FEATURE_FORMAT, maxTemplateDate: settings.max_template_date, dataDir: settings.data_dir };
  const key = paths.featureSetKey({ ...versionOf(proteome), tag: config.featureSetTag, ...build });
  const dir = await store.ensureFeatureSet(config.libraryDir, key, {
    proteome: {
      upid: proteome.upid, organism: proteome.organism, taxId: proteome.tax_id, release: proteome.release_name,
      releaseDate: proteome.release_date, subset: proteome.subset, sha256: proteome.sha256
    },
    config: { tag: config.featureSetTag, format: build.format, maxTemplateDate: build.maxTemplateDate, databaseDir: build.dataDir }
  });
  await conn.query(
    `INSERT INTO alphapulldown_library_feature_sets (proteome_id, set_key, tag, format, max_template_date, data_dir, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
    [proteome.id, key, config.featureSetTag, build.format, build.maxTemplateDate, build.dataDir, userId || null]
  );
  const rows = await conn.query('SELECT * FROM alphapulldown_library_feature_sets WHERE set_key = ?', [key]);
  return { row: rows[0], dir };
}

module.exports = { DEFAULT_TAG, loadConfig, saveConfig, versionOf, insertProteome, findProteome, ensureSet };
