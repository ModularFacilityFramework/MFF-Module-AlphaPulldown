// Reads a 3D model file (mmCIF or legacy PDB) and returns what the Target tab
// needs: the entry id and title, and one record per protein chain with its
// amino-acid sequence. Pure: text in, object out - nothing touches the disk
// or the network, so it is unit-tested without a running mff-core.
//
// mmCIF is parsed with the `ciftools` library (the Mol* CIF parser). It is
// published as a browser bundle that wants a global `window` while it loads,
// so the global is set for the length of the require() and removed again:
// this module runs inside core's own process and must not leave a `window`
// behind for other code to mistake for a browser.
//
// The sequence of a chain is the SEQRES / entity_poly sequence (the full
// construct, including residues that were not resolved), not just the atoms
// that were observed; the atoms are the fallback when a file has no
// sequence records.

const THREE_TO_ONE = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  // Common modified residues, mapped to the residue they derive from.
  MSE: 'M', SEP: 'S', TPO: 'T', PTR: 'Y', CSO: 'C', HYP: 'P', MLY: 'K', KCX: 'K', CME: 'C', SEC: 'U', PYL: 'O'
};
const MAX_MODEL_CHARS = 60 * 1024 * 1024;

let ciftools = null;
function loadCiftools() {
  if (ciftools) return ciftools;
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  if (!had) global.window = global;
  try {
    // eslint-disable-next-line global-require
    ciftools = require('ciftools');
  } finally {
    if (!had) delete global.window;
  }
  return ciftools;
}

function detectFormat(text) {
  const head = text.slice(0, 20000);
  if (/^data_/m.test(head) || /^loop_/m.test(head) || /^_atom_site\./m.test(head) || /^_entry\./m.test(head)) return 'mmcif';
  if (/^(HEADER|TITLE\s|ATOM\s{2}|HETATM|SEQRES|REMARK|MODEL\s|CRYST1|COMPND)/m.test(head)) return 'pdb';
  return null;
}

function cleanSequence(text) {
  return String(text || '').replace(/\s+/g, '').toUpperCase();
}

function toOneLetter(threeLetterCodes) {
  return threeLetterCodes.map(code => THREE_TO_ONE[code] || 'X').join('');
}

// ---- mmCIF ---------------------------------------------------------------

function column(category, name) {
  if (!category) return null;
  const field = category.getField(name);
  return field && field.isDefined ? field : null;
}

function cell(category, name, row) {
  const field = column(category, name);
  if (!field) return '';
  const value = field.str(row);
  return value === '?' || value === '.' ? '' : value;
}

function isProteinType(type) {
  return /polypeptide/i.test(type || '');
}

async function readMmcif(text) {
  const { parseText } = loadCiftools();
  const parsed = await parseText(text).run();
  if (parsed.isError || !parsed.result.blocks.length) {
    throw new Error(`Not a readable mmCIF file${parsed.message ? `: ${parsed.message}` : ''}`);
  }
  const block = parsed.result.blocks[0];
  const cat = block.categories;

  const entryId = cell(cat.entry, 'id', 0) || block.header || '';
  const title = cell(cat.struct, 'title', 0);
  const method = cell(cat.exptl, 'method', 0);
  // The date of the entry's newest revision, when the file has a history.
  const revisions = cat.pdbx_audit_revision_history;
  const revisionDate = revisions && revisions.rowCount > 0 ? cell(revisions, 'revision_date', revisions.rowCount - 1) : '';

  // entity id -> { sequence, type, description }
  const entities = new Map();
  const poly = cat.entity_poly;
  for (let i = 0; poly && i < poly.rowCount; i += 1) {
    entities.set(cell(poly, 'entity_id', i), {
      type: cell(poly, 'type', i),
      sequence: cleanSequence(cell(poly, 'pdbx_seq_one_letter_code_can', i) || cell(poly, 'pdbx_seq_one_letter_code', i))
    });
  }
  const entityRows = cat.entity;
  for (let i = 0; entityRows && i < entityRows.rowCount; i += 1) {
    const known = entities.get(cell(entityRows, 'id', i));
    if (known) known.description = cell(entityRows, 'pdbx_description', i);
  }

  // label_asym_id -> author chain id, and what was actually observed.
  const atoms = cat.atom_site;
  const authorOf = new Map();
  const observed = new Map();
  const fallback = new Map();
  for (let i = 0; atoms && i < atoms.rowCount; i += 1) {
    const asym = cell(atoms, 'label_asym_id', i);
    if (!asym) continue;
    if (!authorOf.has(asym)) authorOf.set(asym, cell(atoms, 'auth_asym_id', i) || asym);
    if (cell(atoms, 'label_atom_id', i) !== 'CA') continue;
    const seqId = cell(atoms, 'label_seq_id', i) || cell(atoms, 'auth_seq_id', i);
    const seen = observed.get(asym) || new Set();
    if (!seen.has(seqId)) {
      seen.add(seqId);
      observed.set(asym, seen);
      const residues = fallback.get(asym) || [];
      residues.push(cell(atoms, 'label_comp_id', i));
      fallback.set(asym, residues);
    }
  }

  const chains = [];
  const asymRows = cat.struct_asym;
  if (asymRows && asymRows.rowCount > 0) {
    for (let i = 0; i < asymRows.rowCount; i += 1) {
      const asym = cell(asymRows, 'id', i);
      const entity = entities.get(cell(asymRows, 'entity_id', i));
      if (!entity || !isProteinType(entity.type)) continue;
      const sequence = entity.sequence || toOneLetter(fallback.get(asym) || []);
      if (!sequence) continue;
      chains.push({
        id: authorOf.get(asym) || asym,
        asymId: asym,
        entityId: cell(asymRows, 'entity_id', i),
        description: entity.description || '',
        sequence,
        observedResidues: (observed.get(asym) || new Set()).size
      });
    }
  } else {
    // No struct_asym: take the atoms' own chains.
    for (const [asym, residues] of fallback) {
      const sequence = toOneLetter(residues);
      if (sequence) chains.push({ id: authorOf.get(asym) || asym, asymId: asym, entityId: '', description: '', sequence, observedResidues: residues.length });
    }
  }
  return { format: 'mmcif', entryId, title, method, revisionDate, chains };
}

// ---- PDB -----------------------------------------------------------------

function readPdb(text) {
  const lines = text.split(/\r?\n/);
  let entryId = '';
  let title = '';
  let method = '';
  const seqres = new Map();
  const atomResidues = new Map();
  const seenAtoms = new Map();
  for (const line of lines) {
    const record = line.slice(0, 6);
    if (record === 'HEADER') entryId = line.slice(62, 66).trim();
    else if (record === 'TITLE ') title += ` ${line.slice(10, 80).trim()}`;
    else if (record === 'EXPDTA') method = line.slice(10, 79).trim();
    else if (record === 'SEQRES') {
      const chain = line.slice(11, 12).trim() || '_';
      const residues = line.slice(19, 80).trim().split(/\s+/).filter(Boolean);
      seqres.set(chain, (seqres.get(chain) || []).concat(residues));
    } else if (record === 'ATOM  ' && line.slice(12, 16).trim() === 'CA') {
      const chain = line.slice(21, 22).trim() || '_';
      const key = `${chain}|${line.slice(22, 27)}`;
      if (seenAtoms.has(key)) continue;
      seenAtoms.set(key, true);
      atomResidues.set(chain, (atomResidues.get(chain) || []).concat(line.slice(17, 20).trim()));
    } else if (record === 'ENDMDL') {
      break; // first model only
    }
  }
  const chains = [];
  const ids = [...new Set([...seqres.keys(), ...atomResidues.keys()])];
  for (const id of ids) {
    const full = seqres.get(id);
    const ca = atomResidues.get(id) || [];
    // SEQRES also lists nucleic acids (one-letter or two-letter codes); a
    // protein chain is one whose residues are three-letter amino acids.
    const residues = full && full.some(code => THREE_TO_ONE[code]) ? full : ca;
    if (!residues.some(code => THREE_TO_ONE[code])) continue;
    chains.push({ id, asymId: id, entityId: '', description: '', sequence: toOneLetter(residues), observedResidues: ca.length });
  }
  return { format: 'pdb', entryId, title: title.trim(), method, revisionDate: '', chains };
}

// ---- entry point -----------------------------------------------------------

// Returns { format, entryId, title, method, chains: [{ id, asymId, entityId,
// description, sequence, observedResidues }] } or throws an Error whose
// message is fit to show the user.
async function readModel(text) {
  const source = String(text || '');
  if (!source.trim()) throw new Error('The file is empty');
  if (source.length > MAX_MODEL_CHARS) throw new Error('The model file is larger than 60 MB');
  const format = detectFormat(source);
  if (!format) throw new Error('Not an mmCIF or PDB file');
  const model = format === 'mmcif' ? await readMmcif(source) : readPdb(source);
  if (model.chains.length === 0) throw new Error('No protein chain was found in this model');
  return model;
}

module.exports = { readModel, detectFormat, THREE_TO_ONE, MAX_MODEL_CHARS };
