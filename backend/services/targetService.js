// Database side of the Target tab: turning the stored rows into the record
// the tab shows (and the rules in targetRules.js work on), saving a draft,
// checking the chains against the chosen genome, and the event log. Every
// target belongs to one project and one owner; who may see or change it is
// decided by the routes (targetRoutes.js), not here.
const crypto = require('crypto');
const rules = require('./targetRules');
const library = require('./libraryService');
const libraryStore = require('./libraryStore');

function parseJson(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

// A fingerprint of what the user decided about the target: its chains and
// the genome. Changing any of it reopens a confirmed target.
function signatureOf({ chains, genomeUpid }) {
  const body = chains.map(c => [c.label, c.origin, c.accession || '', c.sequence, c.copies]);
  return crypto.createHash('sha256').update(JSON.stringify({ body, genomeUpid: genomeUpid || '' })).digest('hex');
}

// Rows -> the record shared by the API and the rules. `events` newest first.
function describeTarget(row, chainRows, eventRows = []) {
  const chains = chainRows
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(c => {
      const validation = c.validation_status ? { ...(parseJson(c.validation_json, {})), status: c.validation_status, checkedAt: c.validated_at } : null;
      return {
        id: Number(c.id),
        position: c.position,
        label: c.label,
        origin: c.origin,
        accession: c.accession || null,
        copies: c.copies,
        length: c.length,
        sequence: c.sequence,
        originalSequence: c.original_sequence || null,
        editKind: c.edit_kind || 'own',
        edited: !!c.edit_kind && c.edit_kind !== 'none' && c.edit_kind !== 'own',
        editSummary: c.edit_summary || '',
        uniprot: parseJson(c.uniprot_json),
        validation
      };
    });

  const genomeDetail = parseJson(row.genome_json, {});
  const genome = row.genome_upid
    ? { upid: row.genome_upid, organism: row.genome_organism || '', taxId: row.genome_tax_id, ...genomeDetail }
    : null;

  const modelDetail = parseJson(row.model_json, null);
  let model = null;
  let modelChains = [];
  if (row.model_source && modelDetail) {
    modelChains = modelDetail.chains || [];
    const mapping = rules.mapModelToChains(chains, modelChains);
    model = {
      source: row.model_source,
      sourceLabel: rules.MODEL_SOURCES[row.model_source] || row.model_source,
      modelId: row.model_id || '',
      version: row.model_version || '',
      filename: row.model_filename || '',
      sha256: row.model_sha256 || '',
      bytes: row.model_bytes === null || row.model_bytes === undefined ? null : Number(row.model_bytes),
      fetchedAt: row.model_fetched_at,
      state: row.model_state || 'selected',
      acceptedAt: row.model_accepted_at,
      format: modelDetail.format,
      entryId: modelDetail.entryId,
      title: modelDetail.title,
      method: modelDetail.method,
      revisionDate: modelDetail.revisionDate,
      url: modelDetail.url || '',
      createdDate: modelDetail.createdDate || '',
      tool: modelDetail.tool || '',
      chains: modelChains.map(c => ({ id: c.id, length: c.sequence.length, description: c.description || '', observedResidues: c.observedResidues })),
      mapping,
      covers: rules.modelCovers(mapping),
      acceptedMapping: parseJson(row.model_mapping_json)
    };
  }

  const chimera = rules.assessChimera(chains);
  chimera.acknowledged = parseJson(row.chimera_json);

  const target = {
    id: Number(row.id),
    projectId: Number(row.project_id),
    ownerId: Number(row.owner_id),
    name: row.name || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validatedAt: row.validated_at,
    confirmedAt: row.confirmed_at,
    genome,
    chains,
    model,
    chimera,
    events: eventRows.map(e => ({ id: Number(e.id), event: e.event, detail: parseJson(e.detail_json), at: e.created_at, userId: e.user_id === null ? null : Number(e.user_id) }))
  };
  target.problems = rules.confirmProblems(target);
  target.methods = rules.methodsText(target);
  return target;
}

async function findByProject(conn, projectId) {
  const rows = await conn.query('SELECT * FROM alphapulldown_targets WHERE project_id = ?', [projectId]);
  return rows[0] || null;
}

async function loadFull(conn, row) {
  const [chainRows, eventRows] = await Promise.all([
    conn.query('SELECT * FROM alphapulldown_target_chains WHERE target_id = ? ORDER BY position', [row.id]),
    conn.query('SELECT * FROM alphapulldown_target_events WHERE target_id = ? ORDER BY id DESC LIMIT 50', [row.id])
  ]);
  return describeTarget(row, chainRows, eventRows);
}

async function addEvent(conn, targetId, userId, event, detail) {
  await conn.query(
    'INSERT INTO alphapulldown_target_events (target_id, user_id, event, detail_json) VALUES (?, ?, ?, ?)',
    [targetId, userId || null, event, detail === undefined ? null : JSON.stringify(detail)]
  );
}

// Writes the draft: the target row (created on first save) and its chains,
// replacing the previous chains (their genome checks are redone by the
// caller). `chains` carry what the route worked out: normalised input plus
// originalSequence, edit and uniprot. `genome` is { upid, organism, taxId,
// detail } or null. With `reopen`, a confirmed target goes back to a draft
// and loses its chimera acknowledgement - the caller sets it when the chains
// or the genome changed; a name-only change leaves the target as it is.
// Returns { id, existed }.
async function saveDraft(conn, { project, name, chains, genome, reopen }) {
  const existing = await findByProject(conn, project.id);
  const genomeValues = [genome ? genome.upid : null, genome ? genome.organism : null, genome ? genome.taxId : null, genome ? JSON.stringify(genome.detail) : null];
  let targetId;
  if (existing) {
    targetId = Number(existing.id);
    await conn.query(
      `UPDATE alphapulldown_targets SET name = ?, genome_upid = ?, genome_organism = ?, genome_tax_id = ?, genome_json = ?,
         status = ?, confirmed_at = ?, confirmed_by = ?, chimera_json = ?, validated_at = NULL
       WHERE id = ?`,
      [
        name, ...genomeValues,
        reopen ? 'draft' : existing.status,
        reopen ? null : existing.confirmed_at,
        reopen ? null : existing.confirmed_by,
        reopen ? null : existing.chimera_json,
        targetId
      ]
    );
  } else {
    const result = await conn.query(
      `INSERT INTO alphapulldown_targets (project_id, owner_id, name, status, genome_upid, genome_organism, genome_tax_id, genome_json)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [project.id, project.owner_id, name, ...genomeValues]
    );
    targetId = Number(result.insertId);
  }
  await conn.query('DELETE FROM alphapulldown_target_chains WHERE target_id = ?', [targetId]);
  for (let i = 0; i < chains.length; i += 1) {
    const c = chains[i];
    await conn.query(
      `INSERT INTO alphapulldown_target_chains
         (target_id, position, label, origin, accession, copies, length, sequence, original_sequence, edit_kind, edit_summary, uniprot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetId, i + 1, c.label, c.origin, c.accession, c.copies, c.sequence.length, c.sequence,
        c.originalSequence || null, c.edit.kind, c.edit.summary || null, c.uniprot ? JSON.stringify(c.uniprot) : null
      ]
    );
  }
  return { id: targetId, existed: !!existing };
}

// The library version of a genome to check own sequences against: the newest
// release, the full proteome in preference to the reviewed-only one.
async function libraryVersionFor(conn, upid) {
  const rows = await conn.query('SELECT * FROM alphapulldown_library_proteomes WHERE upid = ?', [upid]);
  if (rows.length === 0) return null;
  return rows.slice().sort((a, b) => {
    if (a.release_name !== b.release_name) return a.release_name < b.release_name ? 1 : -1;
    return (a.subset === 'all' ? 0 : 1) - (b.subset === 'all' ? 0 : 1);
  })[0];
}

// Checks every chain of the target against its genome and stores the
// results. Returns the freshly loaded record.
async function validateTarget(conn, targetRow, userId) {
  const target = await loadFull(conn, targetRow);
  let entries = null;
  let used = null;
  if (target.genome && target.chains.some(c => c.origin !== 'uniprot')) {
    const config = await library.loadConfig(conn);
    const row = config.configured ? await libraryVersionFor(conn, target.genome.upid) : null;
    if (row) {
      try {
        entries = await libraryStore.loadIndex(config.libraryDir, library.versionOf(row));
        used = { release: row.release_name, releaseDate: row.release_date, subset: row.subset, sha256: row.sha256, entries: row.entries };
      } catch (err) {
        entries = null;
      }
    }
  }
  const checkedAt = new Date();
  for (const chain of target.chains) {
    const result = rules.checkChain(chain, target.genome, entries);
    const detail = { basis: result.basis, detail: result.detail, match: result.match };
    if (used && chain.origin !== 'uniprot') detail.proteome = used;
    await conn.query(
      'UPDATE alphapulldown_target_chains SET validation_status = ?, validation_json = ?, validated_at = ? WHERE id = ?',
      [result.status, JSON.stringify(detail), checkedAt, chain.id]
    );
  }
  await conn.query('UPDATE alphapulldown_targets SET validated_at = ? WHERE id = ?', [checkedAt, targetRow.id]);
  await addEvent(conn, targetRow.id, userId, 'checked_against_genome', {
    genome: target.genome ? target.genome.upid : null,
    library: used
  });
  const fresh = (await conn.query('SELECT * FROM alphapulldown_targets WHERE id = ?', [targetRow.id]))[0];
  return loadFull(conn, fresh);
}

// Everything a project's removal must remove with it.
async function deleteForProject(conn, projectId) {
  const row = await findByProject(conn, projectId);
  if (!row) return;
  await conn.query('DELETE FROM alphapulldown_target_events WHERE target_id = ?', [row.id]);
  await conn.query('DELETE FROM alphapulldown_target_chains WHERE target_id = ?', [row.id]);
  await conn.query('DELETE FROM alphapulldown_targets WHERE id = ?', [row.id]);
}

module.exports = {
  parseJson,
  signatureOf,
  describeTarget,
  findByProject,
  loadFull,
  addEvent,
  saveDraft,
  validateTarget,
  libraryVersionFor,
  deleteForProject
};
