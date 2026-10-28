// FASTA parsing, validation and the two file formats AlphaPulldown reads:
// FASTA (one record per protein) and a protein list (one entry per line).
// Pure functions - no disk, no network - so they are unit-tested without a
// running mff-core.
//
// AlphaPulldown names each protein's feature file after everything following
// ">" in the FASTA header, so the headers this module WRITES are the bare
// protein name and nothing else (see formatFasta).

const NAME_MAX = 100;
const MIN_LENGTH = 10;
const MAX_LENGTH = 20000;
const WRAP = 60;
// The 20 standard residues plus X (unknown). U, O, B, Z and J are rejected
// rather than silently changed: the user decides what they mean.
const VALID_RESIDUES = /^[ACDEFGHIKLMNPQRSTVWYX]+$/;
const UNIPROT_HEADER = /^(?:sp|tr)\|([^|\s]+)\|\S*\s*(.*)$/;

// AlphaPulldown rewrites | : ; # in names; this goes further and keeps only
// characters that are safe in a file name and a list file.
function sanitizeName(raw) {
  return String(raw || '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, NAME_MAX);
}

// Splits FASTA text into { header, sequence } records. Sequence lines are
// joined, whitespace and a trailing "*" are dropped, letters are upper-cased.
// Text with no ">" line at all is one record with an empty header.
function parseFasta(text) {
  const records = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      current = { header: line.slice(1).trim(), sequence: '' };
      records.push(current);
    } else {
      if (!current) {
        current = { header: '', sequence: '' };
        records.push(current);
      }
      current.sequence += line.replace(/\s+/g, '').replace(/\*/g, '').toUpperCase();
    }
  }
  return records;
}

// UniProt headers (sp|P0A7Z4|RPOA_ECOLI Protein name OS=... OX=...) become
// the accession plus the protein name; any other header becomes its first
// word plus the rest as description.
function describeHeader(header) {
  const uniprot = UNIPROT_HEADER.exec(header);
  if (uniprot) {
    return { name: sanitizeName(uniprot[1]), description: uniprot[2].replace(/\s+OS=.*$/, '').trim() };
  }
  const [first, ...rest] = header.split(/\s+/);
  return { name: sanitizeName(first), description: rest.join(' ').trim() };
}

function validateSequence(sequence) {
  const errors = [];
  if (!sequence) return ['empty sequence'];
  if (!VALID_RESIDUES.test(sequence)) {
    const bad = [...new Set(sequence.replace(/[ACDEFGHIKLMNPQRSTVWYX]/g, '').split(''))].slice(0, 5);
    errors.push(`contains characters other than the 20 amino acids and X: ${bad.join(' ')}`);
  }
  if (sequence.length < MIN_LENGTH) errors.push(`shorter than ${MIN_LENGTH} residues`);
  if (sequence.length > MAX_LENGTH) errors.push(`longer than ${MAX_LENGTH} residues`);
  return errors;
}

// One parsed record -> { name, description, sequence, length, errors[] }.
// fallbackName is used when the header gives no usable name.
function buildEntry(record, fallbackName) {
  const described = describeHeader(record.header || '');
  const name = described.name || sanitizeName(fallbackName);
  const errors = name ? [] : ['no usable name'];
  errors.push(...validateSequence(record.sequence));
  return {
    name,
    description: described.description.slice(0, 500),
    sequence: record.sequence,
    length: record.sequence.length,
    errors
  };
}

// Makes names unique inside one batch: a repeat becomes name_2, name_3, ...
function uniqueNames(entries) {
  const seen = new Map();
  return entries.map(entry => {
    const count = (seen.get(entry.name) || 0) + 1;
    seen.set(entry.name, count);
    return count === 1 ? entry : { ...entry, name: `${entry.name}_${count}` };
  });
}

function wrap(sequence) {
  const lines = [];
  for (let i = 0; i < sequence.length; i += WRAP) lines.push(sequence.slice(i, i + WRAP));
  return lines.join('\n');
}

// rows: [{ name, sequence }]. Header is the bare name - see file comment.
function formatFasta(rows) {
  return rows.map(r => `>${r.name}\n${wrap(r.sequence)}\n`).join('');
}

// One protein per line; a copy number above 1 is written as name:copies
// (AlphaPulldown's documented syntax, e.g. Q8I2G6:2 for a dimer).
function formatList(rows) {
  return rows.map(r => (r.copies > 1 ? `${r.name}:${r.copies}\n` : `${r.name}\n`)).join('');
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  sanitizeName,
  parseFasta,
  describeHeader,
  validateSequence,
  buildEntry,
  uniqueNames,
  formatFasta,
  formatList
};
