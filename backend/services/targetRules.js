// The rules of the Target tab, as pure functions (no database, no network) so
// they are unit-tested without a running mff-core: cleaning the chains a user
// typed, describing what they edited, checking a chain against the chosen
// genome, deciding whether a complex is chimeric, matching a 3D model to the
// chains, and writing the methods paragraph.
//
// Words used throughout:
//   target  the protein or complex the user is interested in; one or more chains
//   genome  the UniProt proteome the target comes from (and the baits will be
//           picked from, in the next step)
//   chimera a multi-chain complex with a chain that is not confirmed to come
//           from that genome - its chains may never meet in any real organism
const { parseFasta, validateSequence, sanitizeName, uniqueNames } = require('./fastaTools');
const { compareSequences, findBestMatches } = require('./sequenceMatch');

const MAX_CHAINS = 20;
const MAX_COPIES = 24;
const ACCESSION = /^[A-Z][0-9][A-Z0-9]{3}[0-9]([A-Z][A-Z0-9]{2}[0-9])?(-\d+)?$/;

const CHIMERA_WARNING = 'This complex is chimeric: at least one of its chains is not confirmed to come from the chosen genome, '
  + 'so these chains may never meet in a real organism. You can go ahead, but the predictions and anything built on them '
  + 'need a huge grain of salt.';

const MODEL_SOURCES = {
  pdb: 'PDB entry',
  alphafold_db: 'AlphaFold Protein Structure Database model',
  abcfold: 'model predicted with ABCFold',
  upload: 'uploaded model'
};

function cleanSequence(raw) {
  const text = String(raw || '');
  if (text.includes('>')) {
    const [first] = parseFasta(text);
    return first ? first.sequence : '';
  }
  return text.replace(/\s+/g, '').replace(/\*/g, '').toUpperCase();
}

// input: [{ origin: 'uniprot' | 'sequence', accession, sequence, copies, label }]
// Returns { chains, errors }. A chain keeps the user's sequence exactly as
// typed (cleaned of whitespace and case): it is the golden rule - it IS what
// is used.
function normalizeChains(input) {
  const errors = [];
  if (!Array.isArray(input) || input.length === 0) return { chains: [], errors: ['Add at least one chain.'] };
  if (input.length > MAX_CHAINS) return { chains: [], errors: [`A target has at most ${MAX_CHAINS} chains.`] };
  const chains = input.map((raw, index) => {
    const where = `Chain ${index + 1}`;
    const origin = raw && raw.origin === 'uniprot' ? 'uniprot' : 'sequence';
    const accession = origin === 'uniprot' ? String((raw && raw.accession) || '').trim().toUpperCase() : null;
    if (origin === 'uniprot' && !ACCESSION.test(accession)) errors.push(`${where}: "${accession}" is not a UniProt accession.`);
    const sequence = cleanSequence(raw && raw.sequence);
    for (const problem of validateSequence(sequence)) errors.push(`${where}: ${problem}.`);
    const copies = Number.parseInt(raw && raw.copies, 10);
    if (raw && raw.copies !== undefined && raw.copies !== '' && (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES)) {
      errors.push(`${where}: copies must be between 1 and ${MAX_COPIES}.`);
    }
    const label = sanitizeName(raw && raw.label) || sanitizeName(accession) || `chain_${index + 1}`;
    return { origin, accession, sequence, copies: Number.isInteger(copies) && copies >= 1 ? Math.min(copies, MAX_COPIES) : 1, label };
  });
  const named = uniqueNames(chains.map(c => ({ ...c, name: c.label }))).map(({ name, ...c }) => ({ ...c, label: name }));
  return { chains: named, errors };
}

// What the user changed from the UniProt sequence, in words: null original
// means the sequence was the user's own from the start.
function describeEdit(original, edited) {
  if (!original) return { edited: false, kind: 'own', summary: '' };
  if (original === edited) return { edited: false, kind: 'none', summary: '' };
  const cmp = compareSequences(edited, original);
  if (cmp.status === 'contained') {
    const start = cmp.referenceStart - 1;
    const end = original.length - cmp.referenceEnd;
    const parts = [];
    if (start > 0) parts.push(`${start} residue${start === 1 ? '' : 's'} removed from the start (1-${start})`);
    if (end > 0) parts.push(`${end} residue${end === 1 ? '' : 's'} removed from the end (${cmp.referenceEnd + 1}-${original.length})`);
    return { edited: true, kind: 'trimmed', summary: `${parts.join(' and ')} of the UniProt sequence` };
  }
  if (cmp.status === 'extended') {
    const start = cmp.queryStart - 1;
    const end = edited.length - cmp.queryEnd;
    const parts = [];
    if (start > 0) parts.push(`${start} added before the start`);
    if (end > 0) parts.push(`${end} added after the end`);
    return { edited: true, kind: 'extended', summary: `${parts.join(' and ')}; the UniProt sequence is unchanged inside` };
  }
  const pct = Math.round(cmp.identity * 1000) / 10;
  return {
    edited: true,
    kind: 'modified',
    summary: `Changed from the UniProt sequence: ${cmp.differences} difference${cmp.differences === 1 ? '' : 's'} (${pct}% identity over residues ${cmp.referenceStart}-${cmp.referenceEnd})`
  };
}

// Checks one chain against the chosen genome and says how it knows.
// genome: { upid, organism, taxId } or null. libraryEntries: the parsed
// proteome from the shared library ([{ accession, entry, gene, description,
// sequence }]) or null when that proteome is not in the library.
// Returns { status: 'matched' | 'not_matched' | 'not_checked', basis, detail, match }.
function checkChain(chain, genome, libraryEntries) {
  if (!genome) return { status: 'not_checked', basis: 'no_genome', detail: 'No genome has been chosen yet.', match: null };

  if (chain.origin === 'uniprot' && chain.uniprot) {
    const u = chain.uniprot;
    if ((u.proteomes || []).some(p => p.upid === genome.upid)) {
      return { status: 'matched', basis: 'uniprot_proteome', detail: `UniProt lists ${chain.accession} in proteome ${genome.upid}.`, match: null };
    }
    if (u.taxId && genome.taxId && Number(u.taxId) === Number(genome.taxId)) {
      return { status: 'matched', basis: 'taxon', detail: `${chain.accession} is from taxon ${u.taxId}, the same as the genome (${genome.organism}).`, match: null };
    }
    return {
      status: 'not_matched',
      basis: 'other_organism',
      detail: `${chain.accession} is from ${u.organism || 'another organism'}${u.taxId ? ` (taxon ${u.taxId})` : ''}, not from ${genome.organism || genome.upid}.`,
      match: null
    };
  }

  if (!libraryEntries) {
    return {
      status: 'not_checked',
      basis: 'library_missing',
      detail: `This sequence can only be checked against the proteome ${genome.upid}, which is not in the shared library yet. Add it in the Library tab, then check again.`,
      match: null
    };
  }
  const [best] = findBestMatches(chain.sequence, libraryEntries, { top: 1 });
  if (!best) {
    return { status: 'not_matched', basis: 'not_in_proteome', detail: `No protein of ${genome.organism || genome.upid} matches this sequence.`, match: null };
  }
  const c = best.comparison;
  const entry = best.record;
  const what = {
    exact: `is identical to ${entry.accession}`,
    contained: `is a stretch of ${entry.accession} (residues ${c.referenceStart}-${c.referenceEnd})`,
    extended: `contains all of ${entry.accession}, with extra residues`,
    similar: `is ${Math.round(c.identity * 1000) / 10}% identical to ${entry.accession} (${c.differences} difference${c.differences === 1 ? '' : 's'})`
  }[c.status];
  return {
    status: 'matched',
    basis: `library_${c.status}`,
    detail: `This sequence ${what}${entry.gene ? ` (${entry.gene})` : ''} in the proteome ${genome.upid}.`,
    match: {
      accession: entry.accession,
      entry: entry.entry,
      gene: entry.gene,
      description: entry.description,
      status: c.status,
      identity: c.identity,
      coverage: c.coverage,
      differences: c.differences,
      referenceStart: c.referenceStart,
      referenceEnd: c.referenceEnd
    }
  };
}

// A heteromer has two or more different chain sequences. It is chimeric when
// any of its chains is not confirmed to come from the genome. A single chain
// or a homo-oligomer is never called chimeric (it may still be unchecked).
function assessChimera(chains) {
  const distinct = new Set(chains.map(c => c.sequence)).size;
  const heteromer = distinct >= 2;
  const unconfirmed = chains.filter(c => !(c.validation && c.validation.status === 'matched'));
  return {
    heteromer,
    flagged: heteromer && unconfirmed.length > 0,
    chains: heteromer ? unconfirmed.map(c => c.label) : [],
    warning: CHIMERA_WARNING
  };
}

// Why a target cannot be confirmed yet (empty = it can, apart from a
// chimera acknowledgement, which is asked for separately).
function confirmProblems(target) {
  const problems = [];
  if (!target || target.chains.length === 0) return ['Add at least one chain.'];
  if (!target.genome) problems.push('Choose the genome (source organism) the target comes from.');
  if (target.model && target.model.state !== 'accepted') problems.push('Accept the 3D model, or remove it, before confirming.');
  return problems;
}

const MAPPING_ORDER = { exact: 0, contained: 1, extended: 2, similar: 3, different: 4 };

// For each target chain, the model chain that holds its sequence best:
// [{ chain, modelChain, status, identity, coverage }]. modelChain is null
// when nothing in the model resembles the chain.
function mapModelToChains(chains, modelChains) {
  return chains.map(chain => {
    let best = null;
    for (const mc of modelChains) {
      const cmp = compareSequences(chain.sequence, mc.sequence);
      const better = !best
        || MAPPING_ORDER[cmp.status] < MAPPING_ORDER[best.cmp.status]
        || (cmp.status === best.cmp.status && cmp.identity * cmp.coverage > best.cmp.identity * best.cmp.coverage);
      if (better) best = { mc, cmp };
    }
    if (!best || best.cmp.status === 'different') return { chain: chain.label, modelChain: null, status: 'none', identity: 0, coverage: 0 };
    return { chain: chain.label, modelChain: best.mc.id, status: best.cmp.status, identity: best.cmp.identity, coverage: best.cmp.coverage };
  });
}

// A model "covers" a chain when it holds the whole chain sequence.
function modelCovers(mapping) {
  return mapping.length > 0 && mapping.every(m => m.status === 'exact' || m.status === 'contained');
}

function plural(n, word) {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
}

function dateOnly(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

// The methods paragraph for the target, from what was recorded. A fact that
// was not recorded is left out rather than guessed.
function methodsText(target) {
  if (!target || target.chains.length === 0) return '';
  const sentences = [];
  const total = target.chains.reduce((n, c) => n + c.copies, 0);
  sentences.push(`The target was defined as ${plural(target.chains.length, 'chain')}${total !== target.chains.length ? ` (${plural(total, 'copy')} in the complex)` : ''}.`);

  for (const chain of target.chains) {
    const copies = chain.copies > 1 ? `, present in ${chain.copies} copies` : '';
    if (chain.origin === 'uniprot' && chain.uniprot) {
      const u = chain.uniprot;
      const release = u.release ? ` (UniProt release ${u.release}${u.releaseDate ? `, ${u.releaseDate}` : ''})` : '';
      const edit = chain.edited ? `, with the sequence edited: ${chain.editSummary}` : ', with the UniProt sequence used unchanged';
      sentences.push(`Chain ${chain.label} (${chain.length} residues${copies}) is UniProt entry ${chain.accession}${u.organism ? ` from ${u.organism}` : ''}${release}${edit}.`);
    } else {
      sentences.push(`Chain ${chain.label} (${chain.length} residues${copies}) is a sequence supplied by the user.`);
    }
  }

  if (target.genome) {
    const g = target.genome;
    const assembly = g.genomeAssembly && g.genomeAssembly.id ? `, genome assembly ${g.genomeAssembly.id}` : '';
    const type = g.proteomeType ? `, ${g.proteomeType.toLowerCase()}` : '';
    sentences.push(`The source genome was chosen by the user as the UniProt proteome ${g.upid} (${g.organism}, taxon ${g.taxId}${type}${assembly}).`);
    const checked = target.chains.filter(c => c.validation && c.validation.status === 'matched');
    const notMatched = target.chains.filter(c => !c.validation || c.validation.status !== 'matched');
    if (checked.length > 0) sentences.push(`${plural(checked.length, 'chain')} (${checked.map(c => c.label).join(', ')}) ${checked.length === 1 ? 'was' : 'were'} confirmed to come from this genome.`);
    if (notMatched.length > 0) sentences.push(`${plural(notMatched.length, 'chain')} (${notMatched.map(c => c.label).join(', ')}) could not be confirmed to come from this genome.`);
  }

  if (target.chimera && target.chimera.acknowledged) {
    sentences.push(`The complex was flagged as chimeric (${target.chimera.acknowledged.chains.join(', ')} not confirmed to come from the genome) and the user acknowledged this warning on ${dateOnly(target.chimera.acknowledged.at)}.`);
  }

  const m = target.model;
  if (m) {
    const kind = MODEL_SOURCES[m.source] || 'model';
    const id = m.modelId ? ` ${m.modelId}` : '';
    const version = m.version ? `, version ${m.version}` : '';
    const when = m.fetchedAt ? `, obtained on ${dateOnly(m.fetchedAt)}` : '';
    const state = m.state === 'accepted' ? ' and accepted by the user as the target model' : '';
    sentences.push(`A 3D model of the target (${kind}${id}${version}${when}) was ${m.state === 'accepted' ? 'compared with the chains' : 'loaded'}${state}; it was not used for structure prediction.`);
  }
  if (target.confirmedAt) sentences.push(`The target was confirmed on ${dateOnly(target.confirmedAt)}.`);
  return sentences.join(' ');
}

module.exports = {
  MAX_CHAINS,
  MAX_COPIES,
  ACCESSION,
  CHIMERA_WARNING,
  MODEL_SOURCES,
  cleanSequence,
  normalizeChains,
  describeEdit,
  checkChain,
  assessChimera,
  confirmProblems,
  mapModelToChains,
  modelCovers,
  methodsText
};
