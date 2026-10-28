// The numbers shown in the stats strip: how many proteins, how many pairs
// AlphaPulldown would fold, how many amino acids, how big the complexes are.
// Pure functions over plain {role, name, length, copies} rows - no database,
// no disk - so they can be unit-tested without a running mff-core.
//
// Pair lengths are never enumerated: a pulldown of a whole proteome against
// another has hundreds of millions of pairs. Instead everything is derived
// from sorted length arrays plus a counting function ("how many pairs are at
// most x residues long"), which also gives an exact median by bisection and
// an exact over-the-limit count.

const MODES = ['pulldown', 'all_vs_all', 'homo_oligomer'];

function effectiveLength(row) {
  return row.length * (row.copies > 0 ? row.copies : 1);
}

function sortedLengths(rows) {
  return rows.map(effectiveLength).sort((a, b) => a - b);
}

function sum(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

// Index of the first element > x in an ascending array, i.e. how many
// elements are <= x.
function countLE(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Lower median of an ascending array (the ceil(n/2)-th value), null if empty.
function lowerMedian(sorted) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

// Describes the set of complexes a mode produces from its protein lists:
// how many there are, and min/max/total length plus a pairsAtMost(x) counter.
// Returns null when the lists cannot form a single complex yet.
function describeComplexes(mode, rows) {
  if (mode === 'pulldown') {
    const baits = sortedLengths(rows.filter(r => r.role === 'bait'));
    const candidates = sortedLengths(rows.filter(r => r.role === 'candidate'));
    if (baits.length === 0 || candidates.length === 0) return null;
    return {
      count: baits.length * candidates.length,
      min: baits[0] + candidates[0],
      max: baits[baits.length - 1] + candidates[candidates.length - 1],
      total: candidates.length * sum(baits) + baits.length * sum(candidates),
      atMost: x => baits.reduce((acc, b) => acc + countLE(candidates, x - b), 0)
    };
  }

  const all = sortedLengths(rows.filter(r => r.role === 'all'));
  if (mode === 'homo_oligomer') {
    if (all.length === 0) return null;
    return {
      count: all.length,
      min: all[0],
      max: all[all.length - 1],
      total: sum(all),
      atMost: x => countLE(all, x)
    };
  }

  // all_vs_all: every unordered pair of two different proteins.
  if (all.length < 2) return null;
  return {
    count: (all.length * (all.length - 1)) / 2,
    min: all[0] + all[1],
    max: all[all.length - 1] + all[all.length - 2],
    total: (all.length - 1) * sum(all),
    atMost: x => {
      const ordered = all.reduce((acc, l) => acc + countLE(all, x - l), 0);
      const selfPairs = countLE(all, Math.floor(x / 2));
      return (ordered - selfPairs) / 2;
    }
  };
}

// Smallest complex length m such that at least half the complexes (rounded
// up) are <= m - the lower median, found by bisection on atMost().
function medianLength(complexes) {
  const target = Math.ceil(complexes.count / 2);
  let lo = complexes.min;
  let hi = complexes.max;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (complexes.atMost(mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// rows: [{ role, name, length, copies }]. limitAA: complexes longer than
// this are counted in overLimit (null/0 disables the check).
function computeStats(rows, { mode = 'pulldown', limitAA = 0 } = {}) {
  const effectiveMode = MODES.includes(mode) ? mode : 'pulldown';

  // A protein can be a bait and a candidate at once; count it, and its
  // residues, only once.
  const unique = new Map();
  rows.forEach(r => { if (!unique.has(r.name)) unique.set(r.name, r.length); });
  const uniqueLengths = [...unique.values()].sort((a, b) => a - b);

  const stats = {
    mode: effectiveMode,
    baits: rows.filter(r => r.role === 'bait').length,
    candidates: rows.filter(r => r.role === 'candidate').length,
    listed: rows.filter(r => r.role === 'all').length,
    uniqueProteins: uniqueLengths.length,
    totalAA: sum(uniqueLengths),
    longestProtein: uniqueLengths.length > 0 ? uniqueLengths[uniqueLengths.length - 1] : null,
    medianProtein: lowerMedian(uniqueLengths),
    pairs: 0,
    complexLength: null,
    overLimit: 0,
    limitAA: limitAA || null
  };

  const complexes = describeComplexes(effectiveMode, rows);
  if (!complexes) return stats;

  stats.pairs = complexes.count;
  stats.complexLength = {
    min: complexes.min,
    median: medianLength(complexes),
    max: complexes.max,
    total: complexes.total
  };
  if (limitAA > 0) stats.overLimit = complexes.count - complexes.atMost(limitAA);
  return stats;
}

// Which sequence roles a project of this mode holds: baits and candidates for
// a pulldown, one undifferentiated list otherwise.
function rolesForMode(mode) {
  return mode === 'pulldown' ? ['bait', 'candidate'] : ['all'];
}

module.exports = { MODES, computeStats, rolesForMode };
