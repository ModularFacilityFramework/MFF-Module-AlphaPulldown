// Compares protein sequences: one against one (compareSequences) and one
// against a whole list, such as a proteome or the chains of a 3D model
// (findBestMatches). Used by the Target tab to check that a chain really is a
// protein of the chosen genome and that a 3D model really is the target.
// Pure functions - no disk, no network.
//
// Statuses, from the query's point of view:
//   exact      the same sequence
//   contained  the query is a stretch of the reference (a mature chain, a
//              domain: signal peptide or tags removed)
//   extended   the reference is a stretch of the query (tags or linkers added)
//   similar    one local alignment covers most of the query at high identity
//              (point mutants, strain variants)
//   different  none of the above

const MATCH = 2;
const MISMATCH = -1;
const GAP = -3;
// A local alignment needs a (query x reference) table of one byte per cell.
const MAX_CELLS = 40 * 1000 * 1000;
const SIMILAR_IDENTITY = 0.9;
const SIMILAR_COVERAGE = 0.8;
const KMER = 5;
const MIN_SHARED_KMERS = 3;
const STATUS_ORDER = { exact: 0, contained: 1, extended: 2, similar: 3, different: 4 };

// Smith-Waterman with a linear gap penalty. Returns the best local alignment:
// how many columns matched, mismatched or were gaps, and the residue ranges
// (1-based, inclusive) it spans in each sequence. null when the sequences are
// too big for the table.
function localAlign(query, reference) {
  const n = query.length;
  const m = reference.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return null;
  // Traceback directions: 0 stop, 1 diagonal, 2 up (gap in reference), 3 left.
  const trace = new Uint8Array((n + 1) * (m + 1));
  let previous = new Int32Array(m + 1);
  let current = new Int32Array(m + 1);
  let best = 0;
  let bestI = 0;
  let bestJ = 0;
  for (let i = 1; i <= n; i += 1) {
    current[0] = 0;
    const q = query.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      const diagonal = previous[j - 1] + (q === reference.charCodeAt(j - 1) ? MATCH : MISMATCH);
      const up = previous[j] + GAP;
      const left = current[j - 1] + GAP;
      let score = 0;
      let direction = 0;
      if (diagonal > score) { score = diagonal; direction = 1; }
      if (up > score) { score = up; direction = 2; }
      if (left > score) { score = left; direction = 3; }
      current[j] = score;
      trace[i * (m + 1) + j] = direction;
      if (score > best) { best = score; bestI = i; bestJ = j; }
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  if (best === 0) return { matches: 0, mismatches: 0, gaps: 0, queryStart: 0, queryEnd: 0, referenceStart: 0, referenceEnd: 0 };

  let i = bestI;
  let j = bestJ;
  let matches = 0;
  let mismatches = 0;
  let gaps = 0;
  while (i > 0 && j > 0) {
    const direction = trace[i * (m + 1) + j];
    if (direction === 0) break;
    if (direction === 1) {
      if (query.charCodeAt(i - 1) === reference.charCodeAt(j - 1)) matches += 1;
      else mismatches += 1;
      i -= 1;
      j -= 1;
    } else if (direction === 2) {
      gaps += 1;
      i -= 1;
    } else {
      gaps += 1;
      j -= 1;
    }
  }
  return { matches, mismatches, gaps, queryStart: i + 1, queryEnd: bestI, referenceStart: j + 1, referenceEnd: bestJ };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

// query and reference: upper-case one-letter strings.
function compareSequences(query, reference) {
  const q = String(query || '');
  const r = String(reference || '');
  const empty = { status: 'different', identity: 0, coverage: 0, referenceCoverage: 0, differences: 0, queryStart: 0, queryEnd: 0, referenceStart: 0, referenceEnd: 0 };
  if (!q || !r) return empty;
  if (q === r) {
    return { ...empty, status: 'exact', identity: 1, coverage: 1, referenceCoverage: 1, queryStart: 1, queryEnd: q.length, referenceStart: 1, referenceEnd: r.length };
  }
  const inside = r.indexOf(q);
  if (inside >= 0) {
    return { ...empty, status: 'contained', identity: 1, coverage: 1, referenceCoverage: round(q.length / r.length), queryStart: 1, queryEnd: q.length, referenceStart: inside + 1, referenceEnd: inside + q.length };
  }
  const outside = q.indexOf(r);
  if (outside >= 0) {
    return { ...empty, status: 'extended', identity: 1, coverage: round(r.length / q.length), referenceCoverage: 1, queryStart: outside + 1, queryEnd: outside + r.length, referenceStart: 1, referenceEnd: r.length };
  }
  const aligned = localAlign(q, r);
  if (!aligned || aligned.matches === 0) return empty;
  const columns = aligned.matches + aligned.mismatches + aligned.gaps;
  const identity = aligned.matches / columns;
  const coverage = (aligned.queryEnd - aligned.queryStart + 1) / q.length;
  const result = {
    status: identity >= SIMILAR_IDENTITY && coverage >= SIMILAR_COVERAGE ? 'similar' : 'different',
    identity: round(identity),
    coverage: round(coverage),
    referenceCoverage: round((aligned.referenceEnd - aligned.referenceStart + 1) / r.length),
    differences: aligned.mismatches + aligned.gaps,
    queryStart: aligned.queryStart,
    queryEnd: aligned.queryEnd,
    referenceStart: aligned.referenceStart,
    referenceEnd: aligned.referenceEnd
  };
  return result;
}

function kmers(sequence) {
  const set = new Set();
  for (let i = 0; i + KMER <= sequence.length; i += 1) set.add(sequence.slice(i, i + KMER));
  return set;
}

// How well one comparison reads: exact first, then by identity and coverage.
function rank(a, b) {
  const order = STATUS_ORDER[a.comparison.status] - STATUS_ORDER[b.comparison.status];
  if (order !== 0) return order;
  const score = x => x.comparison.identity * x.comparison.coverage;
  return score(b) - score(a);
}

// records: [{ sequence, ...anything }]. Returns the best `top` records that
// are more than "different" from the query, each as { record, comparison },
// best first. Records that hold the query exactly (or inside) are looked for
// by plain substring search; only when there are none are candidates found
// by shared 5-mers and aligned.
function findBestMatches(query, records, { top = 3 } = {}) {
  const q = String(query || '');
  if (!q) return [];
  const direct = [];
  for (const record of records) {
    const sequence = record.sequence;
    if (sequence === q || sequence.includes(q) || (sequence.length >= 20 && q.includes(sequence))) {
      direct.push({ record, comparison: compareSequences(q, sequence) });
    }
  }
  if (direct.length > 0) return direct.sort(rank).slice(0, top);

  const wanted = kmers(q);
  if (wanted.size === 0) return [];
  const scored = [];
  for (const record of records) {
    const sequence = record.sequence;
    let shared = 0;
    for (let i = 0; i + KMER <= sequence.length; i += 1) {
      if (wanted.has(sequence.slice(i, i + KMER))) shared += 1;
    }
    if (shared >= MIN_SHARED_KMERS) scored.push({ record, shared });
  }
  scored.sort((a, b) => b.shared - a.shared);
  return scored
    .slice(0, 5)
    .map(({ record }) => ({ record, comparison: compareSequences(q, record.sequence) }))
    .filter(match => match.comparison.status !== 'different')
    .sort(rank)
    .slice(0, top);
}

module.exports = { compareSequences, findBestMatches, localAlign, SIMILAR_IDENTITY, SIMILAR_COVERAGE };
