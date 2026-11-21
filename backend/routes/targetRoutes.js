// The Target tab's backend. A target (one chain or several, the protein the
// user is interested in) belongs to one project and one owner; a project
// holds one or many targets. Only the
// owner sees or changes it; developers and administrators may READ every
// target (never change it). Everything this module needs from core comes
// through coreApi (see docs/MFF-Core_module-core-api.md).
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
const { httpError } = require('../services/routeHelpers');

const STAFF_ROLES = ['developer', 'administrator'];
const TARGETS_DIRNAME = 'targets';
const MODEL_STORE_SOURCES = ['pdb', 'alphafold_db'];
const UPLOAD_SOURCES = ['upload', 'abcfold'];
const GENOME_VIA = ['search', 'suggestion', 'upid'];

function isStaff(req) {
  return ((req.user && req.user.roles) || []).some(role => STAFF_ROLES.includes(role));
}

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

  // Who may do what: the owner reads and writes; a developer or
  // administrator reads; anyone else is told it does not exist.
  function allow(project, req, write) {
    const owner = Number(project.owner_id) === Number(req.user.id);
    if (!owner && (write || !isStaff(req))) throw httpError(404, 'Not found');
    return owner;
  }

  // The project named by :id in the path.
  async function accessProject(conn, req, { write = false } = {}) {
    const rows = await conn.query('SELECT * FROM alphapulldown_projects WHERE id = ?', [req.params.id]);
    if (!rows[0]) throw httpError(404, 'Project not found');
    return { project: rows[0], owner: allow(rows[0], req, write) };
  }

  // The target named by :tid in the path, with its project.
  async function accessTarget(conn, req, { write = false } = {}) {
    const row = await service.findById(conn, req.params.tid);
    if (!row) throw httpError(404, 'Target not found');
    const projects = await conn.query('SELECT * FROM alphapulldown_projects WHERE id = ?', [row.project_id]);
    if (!projects[0]) throw httpError(404, 'Target not found');
    return { row, project: projects[0], owner: allow(projects[0], req, write) };
  }

  // People are shown as "First Last (username)" (core's UI rule); a user
  // with no name on record is shown by username alone.
  function personLabel(user) {
    if (!user) return '';
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return name ? `${name} (${user.username})` : user.username;
  }

  async function ownerName(ownerId) {
    try {
      const users = await coreApi.listUsers();
      return personLabel(users.find(u => Number(u.id) === Number(ownerId)));
    } catch (err) {
      return '';
    }
  }

  async function view(conn, project, owner, row) {
    const target = row ? await service.loadFull(conn, row) : null;
    const library = await conn.query('SELECT COUNT(*) AS n FROM alphapulldown_library_proteomes');
    return {
      project: { id: Number(project.id), number: project.project_number, name: project.name },
      readOnly: !owner,
      ownerName: owner ? '' : await ownerName(project.owner_id),
      target,
      chimeraWarning: rules.CHIMERA_WARNING,
      libraryProteomes: Number(library[0].n)
    };
  }

  async function workspaceDir(req, project, targetId) {
    const workspace = await coreApi.getUserWorkspacePath(req.user);
    if (!workspace.active) throw httpError(503, 'Workspace storage is not available for this user.');
    const dir = path.join(projectDir(workspace.path, project.project_number), TARGETS_DIRNAME, `T${Number(targetId)}`);
    if (!isInside(path.join(workspace.path, MODULE_DIRNAME), dir)) throw httpError(500, 'Model folder is outside the workspace.');
    return dir;
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

  // GET /api/alphapulldown/projects/:id/targets - the project's targets in
  // short (for the selector and the locks of the later tabs).
  router.get('/projects/:id/targets', auth, handle('Failed to list the targets', async (req, res) => {
    res.json(await db(async conn => {
      const { project, owner } = await accessProject(conn, req);
      return {
        project: { id: Number(project.id), number: project.project_number, name: project.name },
        readOnly: !owner,
        targets: await service.listForProject(conn, project.id),
        chimeraWarning: rules.CHIMERA_WARNING
      };
    }));
  }));

  // GET /api/alphapulldown/targets/:tid
  router.get('/targets/:tid', auth, handle('Failed to read the target', async (req, res) => {
    res.json(await db(async conn => {
      const { row, project, owner } = await accessTarget(conn, req);
      return view(conn, project, owner, row);
    }));
  }));

  // Saves a target from { name, chains: [{ origin, accession, sequence, copies,
  // label }], genome: { upid, input, via } | null }: a new one in `project`
  // when `existingRow` is null, else the existing one. A draft is kept
  // whether or not anything is valid yet; the chains are then checked against
  // the genome.
  async function saveTarget(req, project, existingRow) {
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
      await conn.beginTransaction();
      let saved;
      try {
        saved = await service.saveDraft(conn, { project, existing: existingRow, name: name || project.name, chains, genome, reopen: reopened });
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
      return view(conn, project, true, await service.findById(conn, saved.id));
    });
  }

  // POST /api/alphapulldown/projects/:id/targets - a new target in the project
  router.post('/projects/:id/targets', auth, handle('Failed to save the target', async (req, res) => {
    const project = await db(async conn => (await accessProject(conn, req, { write: true })).project);
    res.status(201).json(await saveTarget(req, project, null));
  }));

  // PUT /api/alphapulldown/targets/:tid
  router.put('/targets/:tid', auth, handle('Failed to save the target', async (req, res) => {
    const { row, project } = await db(conn => accessTarget(conn, req, { write: true }));
    res.json(await saveTarget(req, project, row));
  }));

  // DELETE /api/alphapulldown/targets/:tid - the target, its history and its
  // model file.
  router.delete('/targets/:tid', auth, handle('Failed to delete the target', async (req, res) => {
    const { row, project } = await db(conn => accessTarget(conn, req, { write: true }));
    await db(conn => service.deleteTarget(conn, row.id));
    const dir = await workspaceDir(req, project, row.id).catch(() => null);
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    res.json({ success: true });
  }));

  // POST /api/alphapulldown/targets/:tid/validate - check again, for example
  // after the genome's proteome was added to the library.
  router.post('/targets/:tid/validate', auth, handle('Failed to check the target', async (req, res) => {
    res.json(await db(async conn => {
      const { row, project } = await accessTarget(conn, req, { write: true });
      await service.validateTarget(conn, row, req.user.id);
      return view(conn, project, true, await service.findById(conn, row.id));
    }));
  }));

  // POST /api/alphapulldown/targets/:tid/confirm - { acknowledgeChimera }
  // Checks the chains once more, then confirms. A chimeric complex is
  // confirmed only with the user's explicit acknowledgement of the warning.
  router.post('/targets/:tid/confirm', auth, handle('Failed to confirm the target', async (req, res) => {
    const acknowledge = !!(req.body && req.body.acknowledgeChimera);
    res.json(await db(async conn => {
      const { row, project } = await accessTarget(conn, req, { write: true });
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
      return view(conn, project, true, await service.findById(conn, row.id));
    }));
  }));

  // ---- the 3D model -------------------------------------------------------------

  // Reads, stores and records a model that is now this target's selected
  // model. The previous model (if any) is replaced.
  async function setModel(req, project, row, { text, source, filename }) {
    let model;
    try {
      model = await readModel(text);
    } catch (err) {
      throw httpError(400, err.message);
    }
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const dir = await workspaceDir(req, project, row.id);
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
           model_fetched_at = NOW(), model_accepted_at = NULL WHERE id = ?`,
        [source.source, source.modelId || model.entryId || null, version || null, relative, filename || null, sha256, Buffer.byteLength(text), JSON.stringify(detail), row.id]
      );
      await reopen(conn, row);
      await service.addEvent(conn, row.id, req.user.id, 'model_loaded', {
        source: source.source, id: source.modelId || model.entryId, version, filename: filename || null, sha256, chains: model.chains.length
      });
      return view(conn, project, true, await service.findById(conn, row.id));
    });
  }

  // POST /api/alphapulldown/targets/:tid/model/fetch - { source: 'pdb' | 'alphafold_db', id }
  router.post('/targets/:tid/model/fetch', auth, handle('Failed to fetch the model', async (req, res) => {
    const body = req.body || {};
    if (!MODEL_STORE_SOURCES.includes(body.source)) throw httpError(400, `source must be one of ${MODEL_STORE_SOURCES.join(', ')}`);
    const { row, project } = await db(conn => accessTarget(conn, req, { write: true }));
    let fetched;
    try {
      fetched = body.source === 'pdb' ? await modelSources.fetchPdb(body.id) : await modelSources.fetchAlphafold(body.id);
    } catch (err) {
      throw httpError(err.status || 502, err.message);
    }
    res.json(await setModel(req, project, row, { text: fetched.text, source: fetched.source, filename: '' }));
  }));

  // POST /api/alphapulldown/targets/:tid/model/upload?filename=&source=upload|abcfold
  // The body is the mmCIF or PDB text itself (Content-Type: text/plain).
  router.post('/targets/:tid/model/upload', auth, express.text({ type: () => true, limit: '60mb' }), handle('Failed to read the model', async (req, res) => {
    const source = UPLOAD_SOURCES.includes(req.query.source) ? req.query.source : 'upload';
    if (typeof req.body !== 'string' || !req.body.trim()) throw httpError(400, 'The model file is empty.');
    const { row, project } = await db(conn => accessTarget(conn, req, { write: true }));
    res.json(await setModel(req, project, row, { text: req.body, source: { source }, filename: safeFilename(req.query.filename) }));
  }));

  // POST /api/alphapulldown/targets/:tid/model/accept - the user has looked
  // at how the model matches the chains and chooses it. The match is recorded
  // as it stood.
  router.post('/targets/:tid/model/accept', auth, handle('Failed to accept the model', async (req, res) => {
    res.json(await db(async conn => {
      const { row, project } = await accessTarget(conn, req, { write: true });
      if (!row.model_source) throw httpError(400, 'There is no model to accept.');
      const target = await service.loadFull(conn, row);
      await conn.query(
        "UPDATE alphapulldown_targets SET model_state = 'accepted', model_accepted_at = NOW(), model_mapping_json = ? WHERE id = ?",
        [JSON.stringify({ covers: target.model.covers, mapping: target.model.mapping }), row.id]
      );
      await service.addEvent(conn, row.id, req.user.id, 'model_accepted', { covers: target.model.covers, mapping: target.model.mapping });
      return view(conn, project, true, await service.findById(conn, row.id));
    }));
  }));

  // DELETE /api/alphapulldown/targets/:tid/model
  router.delete('/targets/:tid/model', auth, handle('Failed to remove the model', async (req, res) => {
    const { row, project } = await db(conn => accessTarget(conn, req, { write: true }));
    const dir = await workspaceDir(req, project, row.id).catch(() => null);
    res.json(await db(async conn => {
      if (!row.model_source) throw httpError(400, 'There is no model to remove.');
      await conn.query(
        `UPDATE alphapulldown_targets SET model_source = NULL, model_id = NULL, model_version = NULL, model_file = NULL, model_filename = NULL,
           model_sha256 = NULL, model_bytes = NULL, model_state = NULL, model_json = NULL, model_mapping_json = NULL,
           model_fetched_at = NULL, model_accepted_at = NULL WHERE id = ?`,
        [row.id]
      );
      await reopen(conn, row);
      await service.addEvent(conn, row.id, req.user.id, 'model_removed', { source: row.model_source, id: row.model_id });
      if (dir) {
        await fs.rm(path.join(dir, 'model.cif'), { force: true });
        await fs.rm(path.join(dir, 'model.pdb'), { force: true });
      }
      return view(conn, project, true, await service.findById(conn, row.id));
    }));
  }));

  // ---- staff ----------------------------------------------------------------------

  // GET /api/alphapulldown/targets - developers and administrators: every
  // user's target, to open read-only.
  router.get('/targets', auth, coreApi.checkRole(STAFF_ROLES), handle('Failed to list targets', async (req, res) => {
    const rows = await db(conn => conn.query(
      `SELECT t.id, t.project_id, t.owner_id, t.name, t.status, t.genome_organism, t.genome_upid, t.updated_at, t.confirmed_at,
              p.project_number, p.name AS project_name,
              (SELECT COUNT(*) FROM alphapulldown_target_chains c WHERE c.target_id = t.id) AS chain_count,
              (SELECT COUNT(*) FROM alphapulldown_target_chains c WHERE c.target_id = t.id AND (c.validation_status IS NULL OR c.validation_status <> 'matched')) AS unconfirmed_count
       FROM alphapulldown_targets t JOIN alphapulldown_projects p ON p.id = t.project_id
       ORDER BY t.updated_at DESC LIMIT 500`
    ));
    let users = [];
    try {
      users = await coreApi.listUsers();
    } catch (err) {
      users = [];
    }
    // listUsers() is already sorted by first name, then last name: list the
    // owners in that order, each one's targets newest first.
    const rank = new Map(users.map((u, i) => [Number(u.id), i]));
    const position = r => (rank.has(Number(r.owner_id)) ? rank.get(Number(r.owner_id)) : users.length);
    rows.sort((a, b) => position(a) - position(b));
    res.json({
      targets: rows.map(r => ({
        targetId: Number(r.id),
        projectId: Number(r.project_id),
        projectNumber: r.project_number,
        projectName: r.project_name,
        name: r.name,
        ownerId: Number(r.owner_id),
        ownerName: personLabel(users.find(u => Number(u.id) === Number(r.owner_id))),
        status: r.status,
        genome: r.genome_upid ? `${r.genome_organism || ''} (${r.genome_upid})`.trim() : '',
        chains: Number(r.chain_count),
        unconfirmedChains: Number(r.unconfirmed_count),
        updatedAt: r.updated_at,
        confirmedAt: r.confirmed_at
      }))
    });
  }));

  return router;
};
