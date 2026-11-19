// The shared library's backend: where it lives (staff), which proteomes it
// holds and what each one is (everyone), adding a proteome (everyone - it is
// one shared copy per UniProt release, so a repeat costs nothing), removing
// one (staff). Everything this module needs from core comes through coreApi
// (see docs/MFF-Core_module-core-api.md).
const express = require('express');
const uniprot = require('../services/uniprotClient');
const store = require('../services/libraryStore');
const paths = require('../services/libraryPaths');
const library = require('../services/libraryService');
const { httpError, makeHelpers } = require('../services/routeHelpers');

function parseMetadata(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    return {};
  }
}

function describeProteome(row) {
  const meta = parseMetadata(row.metadata_json);
  return {
    strain: meta.strain || '',
    genomeAssembly: meta.genomeAssembly || null,
    busco: meta.busco || null,
    proteomeModified: meta.proteomeModified || '',
    id: Number(row.id),
    upid: row.upid,
    release: row.release_name,
    releaseDate: row.release_date,
    subset: row.subset,
    organism: row.organism,
    taxId: row.tax_id,
    proteomeType: row.proteome_type,
    entries: row.entries,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    source: row.source,
    downloadedAt: row.downloaded_at
  };
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();
  const auth = coreApi.authenticateToken;
  const staff = coreApi.checkRole(['developer', 'administrator']);
  const { withConn } = makeHelpers(coreApi);

  async function requireLibrary(conn) {
    const config = await library.loadConfig(conn);
    if (!config.configured) throw httpError(503, 'The shared library has no folder yet. Ask staff to set it in Setup.');
    return config;
  }

  // The same words as the file on disk: what a feature set was built with.
  async function describeSet(config, row) {
    const record = await store.readFeatureSet(config.libraryDir, row.set_key).catch(() => null);
    const environment = record && record.environment;
    return {
      id: Number(row.id),
      key: row.set_key,
      tag: row.tag,
      format: row.format,
      maxTemplateDate: row.max_template_date,
      databaseDir: row.data_dir,
      createdAt: row.created_at,
      features: await store.countFeatures(config.libraryDir, row.set_key),
      environment: environment
        ? { capturedAt: environment.capturedAt, software: environment.software, databases: environment.databases, host: environment.host }
        : null
    };
  }

  // GET /api/alphapulldown/library - the library as the Library tab shows it
  router.get('/library', auth, withConn('Failed to read the library', async (req, res, conn) => {
    const config = await library.loadConfig(conn);
    if (!config.configured) {
      return res.json({ configured: false, libraryDir: '', featureSetTag: config.featureSetTag, proteomes: [], downloads: [] });
    }
    const rows = await conn.query('SELECT * FROM alphapulldown_library_proteomes ORDER BY organism, upid, release_name DESC, subset');
    const sets = await conn.query('SELECT * FROM alphapulldown_library_feature_sets ORDER BY id');
    const used = await conn.query(
      'SELECT proteome_id, COUNT(*) AS n FROM alphapulldown_project_sequences WHERE proteome_id IS NOT NULL GROUP BY proteome_id'
    );
    const usedBy = new Map(used.map(r => [Number(r.proteome_id), Number(r.n)]));
    const proteomes = [];
    for (const row of rows) {
      const own = sets.filter(s => Number(s.proteome_id) === Number(row.id));
      proteomes.push({
        ...describeProteome(row),
        projectProteins: usedBy.get(Number(row.id)) || 0,
        featureSets: await Promise.all(own.map(s => describeSet(config, s)))
      });
    }
    res.json({ configured: true, libraryDir: config.libraryDir, featureSetTag: config.featureSetTag, proteomes, downloads: store.downloadsList() });
  }));

  // PUT /api/alphapulldown/library/config - staff: { libraryDir, featureSetTag }
  router.put('/library/config', auth, staff, withConn('Failed to save the library settings', async (req, res, conn) => {
    const body = req.body || {};
    const libraryDir = String(body.libraryDir || '').trim().replace(/\/+$/, '');
    const featureSetTag = String(body.featureSetTag || library.DEFAULT_TAG).trim();
    if (!paths.isValidLibraryDir(libraryDir)) throw httpError(400, 'The library folder must be an absolute path made of letters, digits, dots, dashes and underscores.');
    if (!paths.TAG.test(featureSetTag)) throw httpError(400, 'The feature set tag must be 1 to 32 letters, digits, dots, dashes or underscores.');
    const current = await library.loadConfig(conn);
    if (current.configured && current.libraryDir !== libraryDir) {
      const [{ n }] = await conn.query('SELECT COUNT(*) AS n FROM alphapulldown_library_proteomes');
      if (Number(n) > 0) throw httpError(409, 'The library already holds proteomes. Move the folder on disk and keep the path, or remove its proteomes first.');
    }
    try {
      await store.ensureLayout(libraryDir);
    } catch (err) {
      throw httpError(400, `The library folder cannot be used: ${err.message}`);
    }
    await library.saveConfig(conn, { libraryDir, featureSetTag }, req.user.id);
    res.json({ configured: true, libraryDir, featureSetTag });
  }));

  // POST /api/alphapulldown/library/proteomes - { upid, reviewedOnly }
  router.post('/library/proteomes', auth, withConn('Failed to start the download', async (req, res, conn) => {
    const config = await requireLibrary(conn);
    const body = req.body || {};
    if (!uniprot.UPID.test(body.upid || '')) throw httpError(400, 'Not a proteome id (expected UP followed by 9 digits)');
    const userId = req.user.id;
    const state = store.startDownload({
      libraryDir: config.libraryDir,
      upid: body.upid,
      reviewedOnly: !!body.reviewedOnly,
      onDone: async metadata => {
        const own = await coreApi.pool.getConnection();
        try {
          await library.insertProteome(own, metadata, userId);
        } finally {
          own.release();
        }
      }
    });
    res.status(202).json(state);
  }));

  // DELETE /api/alphapulldown/library/proteomes/:id - staff. A proteome that
  // a project still points at is not removed: those projects' records (and
  // their runs' provenance) must stay true.
  router.delete('/library/proteomes/:id', auth, staff, withConn('Failed to remove the proteome', async (req, res, conn) => {
    const config = await requireLibrary(conn);
    const row = await library.findProteome(conn, req.params.id);
    if (!row) throw httpError(404, 'Proteome not found');
    const [{ n }] = await conn.query('SELECT COUNT(*) AS n FROM alphapulldown_project_sequences WHERE proteome_id = ?', [row.id]);
    if (Number(n) > 0) throw httpError(409, `${Number(n).toLocaleString('en-GB')} protein(s) in projects come from this proteome. Remove them from those projects first.`);
    const sets = await conn.query('SELECT set_key FROM alphapulldown_library_feature_sets WHERE proteome_id = ?', [row.id]);
    for (const set of sets) await store.removeFeatureSet(config.libraryDir, set.set_key);
    await store.removeProteome(config.libraryDir, library.versionOf(row));
    await conn.query('DELETE FROM alphapulldown_library_feature_sets WHERE proteome_id = ?', [row.id]);
    await conn.query('DELETE FROM alphapulldown_library_proteomes WHERE id = ?', [row.id]);
    res.json({ success: true });
  }));

  return router;
};
