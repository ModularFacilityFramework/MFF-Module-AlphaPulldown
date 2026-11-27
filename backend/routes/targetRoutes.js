// The Target tab's backend. A target (one chain or several, the protein the
// user is interested in) belongs to a Science project; a project holds one or
// many targets. Who may see or change a target is who may see or change its
// project (coreApi.projects): read access reads, write access changes, and an
// archived project is read-only. Each target is listed on its project's page
// as a project item. Everything this module needs from core comes through
// coreApi (see docs/MFF-Core_module-core-api.md).
//
// Order of the work: save the chains (a draft, kept even when nothing is
// validated yet) -> choose the genome -> the chains are checked against it ->
// optionally load and accept a 3D model -> confirm. The Baits tab opens only
// once the target is confirmed (status 'confirmed').
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const uniprot = require('../services/uniprotClient');
const modelSources = require('../services/modelSources');
const { readModel } = require('../services/modelReader');
const rules = require('../services/targetRules');
const service = require('../services/targetService');
const { projectDir, isInside, MODULE_DIRNAME } = require('../services/projectPaths');
const science = require('../services/scienceProjects');
const items = require('../services/projectItems');
const { httpError } = require('../services/httpError');
const { nameLookup } = require('../services/people');

const TARGETS_DIRNAME = 'targets';
const MODEL_STORE_SOURCES = ['pdb', 'alphafold_db'];
const UPLOAD_SOURCES = ['upload', 'abcfold'];
const GENOME_VIA = ['search', 'suggestion', 'upid'];

function safeFilename(raw) {
  const base = path.basename(String(raw || '')).replace(/[^\w.-]/g, '_').slice(0, 200);
  return base || 'model';
}

// UniProt being down is the server's problem, an unknown accession is the
// user's.
function uniprotFailure(accession, err) {
  if (/answered 404/.test(err.message)) return httpError(404, `UniProt has no entry ${accession}.`);
  if (/no longer an active/.test(err.message)) return httpError(404, err.message);
  if (/answered 400/.test(err.message) || /not a UniProt accession/.test(err.message)) return httpError(400, err.message);
  return httpError(502, `UniProt could not be reached: ${err.message}`);
}

function uniprotRecord(entry) {
  return {
    entry: entry.entry,
    name: entry.name,
    gene: entry.gene,
    organism: entry.organism,
    taxId: entry.taxId,
    reviewed: entry.reviewed,
    isoform: entry.isoform,
    md5: entry.md5,
    entryVersion: entry.entryVersion,
    sequenceVersion: entry.sequenceVersion,
    lastSequenceUpdate: entry.lastSequenceUpdate,
    proteomes: entry.proteomes,
    signalPeptide: entry.signalPeptide,
    release: entry.release,
    releaseDate: entry.releaseDate,
    fetchedAt: new Date().toISOString()
  };
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();
  const auth = coreApi.authenticateToken;

  function handle(failureMessage, fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        res.status(err.status || 500).json({ error: err.status ? err.message : failureMessage, message: err.message, details: err.details });
      }
    };
  }

  async function db(fn) {
    const conn = await coreApi.pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      conn.release();
    }
  }

  // The Science project named by :id in the path, as the caller may use it.
  function accessProject(req, { write = false } = {}) {
    return science.requireAccess(coreApi, req.user, req.params.id, { write });
  }

  // The target named by :tid in the path, with its link row (whose work it
  // is) and the caller's access to its project. A target of a project from
  // before the move to Science can only be read, by its owner or staff.
  async function accessTarget(conn, req, { write = false } = {}) {
    const row = await service.findById(conn, req.params.tid);
    if (!row) throw httpError(404, 'Target not found');
    const link = (await science.linkById(conn, row.project_id)) || { id: row.project_id, owner_id: row.owner_id, name: 'an old project', science_project_id: null };
    if (!link.science_project_id) {
      if (Number(link.owner_id) !== Number(req.user.id) && !science.isStaff(req.user)) throw httpError(404, 'Target not found');
      if (write) throw httpError(403, science.NOT_MOVED);
      return { row, link, access: { id: null, number: '', title: link.name, archived: false, isTemplate: false, canRead: true, canWrite: false, reason: science.NOT_MOVED } };
    }
    try {
      return { row, link, access: await science.requireAccess(coreApi, req.user, link.science_project_id, { write }) };
    } catch (err) {
      if (err.status === 404) throw httpError(404, 'Target not found');
      throw err;
    }
  }

  async function ownerName(ownerId) {
    return (await nameLookup(coreApi))(ownerId);
  }

  function describeProject(access) {
    return { id: access.id, number: access.number, name: access.title, archived: access.archived, isTemplate: access.isTemplate };
  }

  async function view(conn, req, access, row) {
    const target = row ? await service.loadFull(conn, row) : null;
    const library = await conn.query('SELECT COUNT(*) AS n FROM alphapulldown_library_proteomes');
    const another = !!row && Number(row.owner_id) !== Number(req.user.id);
    return {
      project: describeProject(access),
      readOnly: !access.canWrite,
      readOnlyReason: access.reason,
      ownerName: another ? await ownerName(row.owner_id) : '',
      target,
      chimeraWarning: rules.CHIMERA_WARNING,
      libraryProteomes: Number(library[0].n)
    };
  }

  // Brings the target's line on its project's page up to date and returns the
  // payload, with a warning in it when Science could not be told.
  async function withItem(req, access, payload) {
    const { target } = payload;
    const warning = await items.registerItem(coreApi, req, access.id,
      items.describeItem(items.ITEM_TYPES.target, target.id, { name: target.name || access.title, status: target.status }));
    return warning ? { ...payload, itemWarning: warning } : payload;
  }

  // The caller's own folder for a target: model files are written to the
  // workspace of whoever loads them, under their folder number for the
  // project.
  async function workspaceDir(req, link, targetId) {
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    if (!workspace.active) throw httpError(503, 'Workspace storage is not available for this user.');
    const dir = path.join(projectDir(workspace.path, link.project_number), TARGETS_DIRNAME, `T${Number(targetId)}`);
    if (!isInside(path.join(workspace.path, MODULE_DIRNAME), dir)) throw httpError(500, 'Model folder is outside the workspace.');
    return dir;
  }

  // Removes the model files of a target from the caller's workspace, if the
  // caller is the one whose workspace holds them (another user's files are
  // left where they are). Never makes a link or fails.
  async function removeOwnModelFiles(req, access, row, { wholeFolder = false } = {}) {
    const holder = Number(row.model_user_id || row.owner_id);
    if (holder !== Number(req.user.id) || !access.id) return;
    try {
      const link = await db(conn => science.findLink(conn, access.id, req.user.id));
      if (!link) return;
      const dir = await workspaceDir(req, link, row.id);
      if (wholeFolder) await fs.rm(dir, { recursive: true, force: true });
      else await Promise.all(['model.cif', 'model.pdb'].map(file => fs.rm(path.join(dir, file), { force: true })));
    } catch (err) {
      // Left behind in the workspace; the database no longer points at it.
    }
  }

  async function reopen(conn, row) {
    if (row.status !== 'confirmed') return false;
    await conn.query("UPDATE alphapulldown_targets SET status = 'draft', confirmed_at = NULL, confirmed_by = NULL, chimera_json = NULL WHERE id = ?", [row.id]);
    return true;
  }

  // ---- lookups used while filling in the tab --------------------------------

  // GET /api/alphapulldown/uniprot/entry/:accession
  router.get('/uniprot/entry/:accession', auth, handle('Failed to look up the UniProt entry', async (req, res) => {
    try {
      res.json(await uniprot.fetchEntry(req.params.accession));
    } catch (err) {
      throw uniprotFailure(req.params.accession, err);
    }
  }));

  // GET /api/alphapulldown/target/genomes?q= - UniProt proteomes matching an
  // organism name, taxon id or proteome id, and which of them the shared
  // library already holds.
  router.get('/target/genomes', auth, handle('Failed to search proteomes', async (req, res) => {
    const text = String(req.query.q || '').trim().slice(0, 200);
    if (!text) throw httpError(400, 'Type an organism name, a taxon id or a proteome id (UP...).');
    const query = /^\d+$/.test(text) ? `taxonomy_id:${text}` : text;
    let found;
    try {
      found = await uniprot.searchProteomes({ query, size: 15 });
    } catch (err) {
      throw httpError(502, `UniProt could not be reached: ${err.message}`);
    }
    const held = found.length > 0
      ? await db(conn => conn.query(`SELECT upid, release_name, subset FROM alphapulldown_library_proteomes WHERE upid IN (${found.map(() => '?').join(', ')})`, found.map(p => p.upid)))
      : [];
    res.json({
      results: found.map(p => ({ ...p, inLibrary: held.filter(h => h.upid === p.upid).map(h => ({ release: h.release_name, subset: h.subset })) }))
    });
  }));

  // ---- the targets of a project ----------------------------------------------------

  // GET /api/alphapulldown/projects/:id/targets - the targets of a Science
  // project in short (for the selector and the locks of the later tabs),
  // whoever made them.
  router.get('/projects/:id/targets', auth, handle('Failed to list the targets', async (req, res) => {
    const access = await accessProject(req);
    res.json(await db(async conn => {
      let targets = [];
      if (access.isTemplate) {
        const old = science.oldWork(req.user);
        targets = await service.listTargets(conn, old.where, old.params);
      } else {
        const links = await science.linksFor(conn, access.id);
        if (links.length > 0) targets = await service.listTargets(conn, `t.project_id IN (${links.map(() => '?').join(', ')})`, links.map(l => l.id));
      }
      return {
        project: describeProject(access),
        readOnly: !access.canWrite,
        readOnlyReason: access.reason,
        targets,
        chimeraWarning: rules.CHIMERA_WARNING
      };
    }));
  }));

  // GET /api/alphapulldown/targets/:tid
  router.get('/targets/:tid', auth, handle('Failed to read the target', async (req, res) => {
    res.json(await db(async conn => {
      const { row, access } = await accessTarget(conn, req);
      return view(conn, req, access, row);
    }));
  }));

  // Saves a target from { name, chains: [{ origin, accession, sequence, copies,
  // label }], genome: { upid, input, via } | null }: a new one in the Science
  // project of `access` when `existingRow` is null, else the existing one. A draft is kept
  // whether or not anything is valid yet; the chains are then checked against
  // the genome.
  async function saveTarget(req, access, existingRow) {
    const body = req.body || {};
    const { chains: normalized, errors } = rules.normalizeChains(body.chains);
    if (errors.length > 0) throw Object.assign(httpError(400, errors.join(' ')), { details: errors });
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : '';
    const existing = existingRow ? await db(conn => service.loadFull(conn, existingRow)) : null;

    // The user's own sequence is what is used. For a chain started from an
    // accession, what UniProt had (sequence, release, organism...) is kept
    // beside it, so the edits can be described and the source cited.
    const fetched = new Map();
    const chains = [];
    for (const chain of normalized) {
      let original = null;
      let record = null;
      if (chain.origin === 'uniprot') {
        const kept = existing && existing.chains.find(c => c.accession === chain.accession && c.uniprot && c.originalSequence);
        if (kept) {
          original = kept.originalSequence;
          record = kept.uniprot;
        } else {
          if (!fetched.has(chain.accession)) {
            try {
              fetched.set(chain.accession, await uniprot.fetchEntry(chain.accession));
            } catch (err) {
              throw uniprotFailure(chain.accession, err);
            }
          }
          const entry = fetched.get(chain.accession);
          original = entry.sequence;
          record = uniprotRecord(entry);
        }
      }
      chains.push({ ...chain, originalSequence: original, uniprot: record, edit: rules.describeEdit(original, chain.sequence) });
    }

    let genome = null;
    const wanted = body.genome && typeof body.genome === 'object' ? body.genome : null;
    if (wanted) {
      if (!uniprot.UPID.test(String(wanted.upid || ''))) throw httpError(400, 'The genome must be a UniProt proteome id (UP followed by 9 digits).');
      if (existing && existing.genome && existing.genome.upid === wanted.upid) {
        const { upid, organism, taxId, ...detail } = existing.genome;
        genome = { upid, organism, taxId, detail };
      } else {
        let info;
        try {
          info = await uniprot.proteomeInfo(wanted.upid);
        } catch (err) {
          throw /answered 404/.test(err.message) ? httpError(404, `UniProt has no proteome ${wanted.upid}.`) : httpError(502, `UniProt could not be reached: ${err.message}`);
        }
        const { upid, organism, taxId, ...rest } = info;
        genome = {
          upid,
          organism,
          taxId,
          detail: { ...rest, input: String(wanted.input || '').slice(0, 200), via: GENOME_VIA.includes(wanted.via) ? wanted.via : 'search', chosenAt: new Date().toISOString() }
        };
      }
    }

    const reopened = !!existing && existing.status === 'confirmed'
      && service.signatureOf({ chains: existing.chains, genomeUpid: existing.genome && existing.genome.upid })
        !== service.signatureOf({ chains, genomeUpid: genome && genome.upid });

    return db(async conn => {
      // A new target is the caller's own, under their link to the project.
      const link = existingRow ? null : await science.ensureLink(conn, access, req.user.id);
      await conn.beginTransaction();
      let saved;
      try {
        saved = await service.saveDraft(conn, { project: link, existing: existingRow, name: name || access.title, chains, genome, reopen: reopened });
        await service.addEvent(conn, saved.id, req.user.id, 'saved', {
          chains: chains.map(c => ({ label: c.label, origin: c.origin, accession: c.accession, length: c.sequence.length, copies: c.copies, edit: c.edit.kind })),
          genome: genome ? genome.upid : null
        });
        if (reopened) await service.addEvent(conn, saved.id, req.user.id, 'reopened', { reason: 'chains or genome changed' });
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
      await service.validateTarget(conn, await service.findById(conn, saved.id), req.user.id);
      return view(conn, req, access, await service.findById(conn, saved.id));
    }).then(payload => withItem(req, access, payload));
  }

  // POST /api/alphapulldown/projects/:id/targets - a new target in the project
  router.post('/projects/:id/targets', auth, handle('Failed to save the target', async (req, res) => {
    const access = await accessProject(req, { write: true });
    res.status(201).json(await saveTarget(req, access, null));
  }));

  // PUT /api/alphapulldown/targets/:tid
  router.put('/targets/:tid', auth, handle('Failed to save the target', async (req, res) => {
    const { row, access } = await db(conn => accessTarget(conn, req, { write: true }));
    res.json(await saveTarget(req, access, row));
  }));

  // DELETE /api/alphapulldown/targets/:tid - the target, its history, its
  // line on the project's page and (when they are the caller's) its model
  // files.
  router.delete('/targets/:tid', auth, handle('Failed to delete the target', async (req, res) => {
    const { row, access } = await db(conn => accessTarget(conn, req, { write: true }));
    await db(conn => service.deleteTarget(conn, row.id));
    await removeOwnModelFiles(req, access, row, { wholeFolder: true });
    const warning = await items.removeItem(coreApi, req, access.id, items.ITEM_TYPES.target, row.id);
    res.json(warning ? { success: true, itemWarning: warning } : { success: true });
  }));

  // POST /api/alphapulldown/targets/:tid/validate - check again, for example
  // after the genome's proteome was added to the library.
  router.post('/targets/:tid/validate', auth, handle('Failed to check the target', async (req, res) => {
    res.json(await db(async conn => {
      const { row, access } = await accessTarget(conn, req, { write: true });
      await service.validateTarget(conn, row, req.user.id);
      return view(conn, req, access, await service.findById(conn, row.id));
    }));
  }));

  // POST /api/alphapulldown/targets/:tid/confirm - { acknowledgeChimera }
  // Checks the chains once more, then confirms. A chimeric complex is
  // confirmed only with the user's explicit acknowledgement of the warning.
  router.post('/targets/:tid/confirm', auth, handle('Failed to confirm the target', async (req, res) => {
    const acknowledge = !!(req.body && req.body.acknowledgeChimera);
    let mine = null;
    const payload = await db(async conn => {
      const { row, access } = await accessTarget(conn, req, { write: true });
      mine = access;
      const target = await service.validateTarget(conn, row, req.user.id);
      if (target.problems.length > 0) throw Object.assign(httpError(400, target.problems.join(' ')), { details: target.problems });
      let chimera = null;
      if (target.chimera.flagged) {
        if (!acknowledge) {
          throw Object.assign(httpError(409, rules.CHIMERA_WARNING), { details: { chimera: target.chimera.chains } });
        }
        chimera = { at: new Date().toISOString(), userId: Number(req.user.id), chains: target.chimera.chains, text: rules.CHIMERA_WARNING };
        await service.addEvent(conn, row.id, req.user.id, 'chimera_acknowledged', { chains: chimera.chains });
      }
      await conn.query(
        "UPDATE alphapulldown_targets SET status = 'confirmed', confirmed_at = NOW(), confirmed_by = ?, chimera_json = ? WHERE id = ?",
        [req.user.id, chimera ? JSON.stringify(chimera) : null, row.id]
      );
      await service.addEvent(conn, row.id, req.user.id, 'confirmed', {
        chains: target.chains.length,
        genome: target.genome.upid,
        unconfirmedChains: target.chimera.flagged ? target.chimera.chains : [],
        model: target.model ? { source: target.model.source, id: target.model.modelId, version: target.model.version } : null
      });
      return view(conn, req, access, await service.findById(conn, row.id));
    });
    res.json(await withItem(req, mine, payload));
  }));

  // ---- the 3D model -------------------------------------------------------------

  // Reads, stores and records a model that is now this target's selected
  // model. The previous model (if any) is replaced.
  async function setModel(req, access, row, { text, source, filename }) {
    let model;
    try {
      model = await readModel(text);
    } catch (err) {
      throw httpError(400, err.message);
    }
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const link = await db(conn => science.ensureLink(conn, access, req.user.id));
    const dir = await workspaceDir(req, link, row.id);
    const file = `model.${model.format === 'pdb' ? 'pdb' : 'cif'}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.rm(path.join(dir, 'model.cif'), { force: true });
    await fs.rm(path.join(dir, 'model.pdb'), { force: true });
    await fs.writeFile(path.join(dir, file), text);
    const relative = path.posix.join(TARGETS_DIRNAME, `T${Number(row.id)}`, file);
    const version = source.version || model.revisionDate || '';
    const detail = {
      format: model.format,
      entryId: model.entryId,
      title: model.title,
      method: model.method,
      revisionDate: model.revisionDate,
      url: source.url || '',
      createdDate: source.createdDate || '',
      tool: source.tool || '',
      chains: model.chains
    };
    return db(async conn => {
      await conn.query(
        `UPDATE alphapulldown_targets SET model_source = ?, model_id = ?, model_version = ?, model_file = ?, model_filename = ?,
           model_sha256 = ?, model_bytes = ?, model_state = 'selected', model_json = ?, model_mapping_json = NULL,
           model_fetched_at = NOW(), model_accepted_at = NULL, model_user_id = ? WHERE id = ?`,
        [source.source, source.modelId || model.entryId || null, version || null, relative, filename || null, sha256, Buffer.byteLength(text), JSON.stringify(detail), req.user.id, row.id]
      );
      await reopen(conn, row);
      await service.addEvent(conn, row.id, req.user.id, 'model_loaded', {
        source: source.source, id: source.modelId || model.entryId, version, filename: filename || null, sha256, chains: model.chains.length
      });
      return view(conn, req, access, await service.findById(conn, row.id));
    }).then(payload => withItem(req, access, payload));
  }

  // POST /api/alphapulldown/targets/:tid/model/fetch - { source: 'pdb' | 'alphafold_db', id }
  router.post('/targets/:tid/model/fetch', auth, handle('Failed to fetch the model', async (req, res) => {
    const body = req.body || {};
    if (!MODEL_STORE_SOURCES.includes(body.source)) throw httpError(400, `source must be one of ${MODEL_STORE_SOURCES.join(', ')}`);
    const { row, access } = await db(conn => accessTarget(conn, req, { write: true }));
    let fetched;
    try {
      fetched = body.source === 'pdb' ? await modelSources.fetchPdb(body.id) : await modelSources.fetchAlphafold(body.id);
    } catch (err) {
      throw httpError(err.status || 502, err.message);
    }
    res.json(await setModel(req, access, row, { text: fetched.text, source: fetched.source, filename: '' }));
  }));

  // POST /api/alphapulldown/targets/:tid/model/upload?filename=&source=upload|abcfold
  // The body is the mmCIF or PDB text itself (Content-Type: text/plain).
  router.post('/targets/:tid/model/upload', auth, express.text({ type: () => true, limit: '60mb' }), handle('Failed to read the model', async (req, res) => {
    const source = UPLOAD_SOURCES.includes(req.query.source) ? req.query.source : 'upload';
    if (typeof req.body !== 'string' || !req.body.trim()) throw httpError(400, 'The model file is empty.');
    const { row, access } = await db(conn => accessTarget(conn, req, { write: true }));
    res.json(await setModel(req, access, row, { text: req.body, source: { source }, filename: safeFilename(req.query.filename) }));
  }));

  // POST /api/alphapulldown/targets/:tid/model/accept - the user has looked
  // at how the model matches the chains and chooses it. The match is recorded
  // as it stood.
  router.post('/targets/:tid/model/accept', auth, handle('Failed to accept the model', async (req, res) => {
    res.json(await db(async conn => {
      const { row, access } = await accessTarget(conn, req, { write: true });
      if (!row.model_source) throw httpError(400, 'There is no model to accept.');
      const target = await service.loadFull(conn, row);
      await conn.query(
        "UPDATE alphapulldown_targets SET model_state = 'accepted', model_accepted_at = NOW(), model_mapping_json = ? WHERE id = ?",
        [JSON.stringify({ covers: target.model.covers, mapping: target.model.mapping }), row.id]
      );
      await service.addEvent(conn, row.id, req.user.id, 'model_accepted', { covers: target.model.covers, mapping: target.model.mapping });
      return view(conn, req, access, await service.findById(conn, row.id));
    }));
  }));

  // DELETE /api/alphapulldown/targets/:tid/model
  router.delete('/targets/:tid/model', auth, handle('Failed to remove the model', async (req, res) => {
    const { row, access } = await db(conn => accessTarget(conn, req, { write: true }));
    if (!row.model_source) throw httpError(400, 'There is no model to remove.');
    const payload = await db(async conn => {
      await conn.query(
        `UPDATE alphapulldown_targets SET model_source = NULL, model_id = NULL, model_version = NULL, model_file = NULL, model_filename = NULL,
           model_sha256 = NULL, model_bytes = NULL, model_state = NULL, model_json = NULL, model_mapping_json = NULL,
           model_fetched_at = NULL, model_accepted_at = NULL, model_user_id = NULL WHERE id = ?`,
        [row.id]
      );
      await reopen(conn, row);
      await service.addEvent(conn, row.id, req.user.id, 'model_removed', { source: row.model_source, id: row.model_id });
      return view(conn, req, access, await service.findById(conn, row.id));
    });
    await removeOwnModelFiles(req, access, row);
    res.json(await withItem(req, access, payload));
  }));

  return router;
};
