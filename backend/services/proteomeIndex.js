// Turns a downloaded UniProt proteome FASTA into a searchable in-memory
// index, so the Proteome browser can filter and page through tens of
// thousands of proteins without touching the database. Pure functions.
const { parseFasta } = require('./fastaTools');

const HEADER = /^(sp|tr)\|([^|\s]+)\|(\S+)\s*(.*)$/;

function parseUniprotFasta(text) {
  const entries = [];
  for (const record of parseFasta(text)) {
    const m = HEADER.exec(record.header);
    if (!m || !record.sequence) continue;
    const rest = m[4];
    const description = rest.replace(/\s+OS=.*$/, '').trim();
    const organism = (/OS=(.*?)\s+OX=/.exec(rest) || [])[1] || '';
    const gene = (/GN=(\S+)/.exec(rest) || [])[1] || '';
    entries.push({
      accession: m[2],
      entry: m[3],
      gene,
      description,
      organism,
      reviewed: m[1] === 'sp',
      length: record.sequence.length,
      sequence: record.sequence,
      search: `${m[2]} ${m[3]} ${gene} ${description}`.toLowerCase()
    });
  }
  return entries;
}

// Every whitespace-separated word of q must appear in the accession, entry
// name, gene or description; minLen/maxLen bound the length (inclusive).
function filterEntries(entries, { q = '', minLen = 0, maxLen = Infinity } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(e => e.length >= minLen && e.length <= maxLen && words.every(w => e.search.includes(w)));
}

// What the browser table shows - no sequence text, which would make a page
// of results tens of times larger.
function summarize(entry) {
  const { sequence, search, ...summary } = entry;
  return summary;
}

module.exports = { parseUniprotFasta, filterEntries, summarize };
