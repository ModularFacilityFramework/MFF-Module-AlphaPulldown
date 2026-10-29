// Turns anonymised speed samples into estimates for a whole run. Pure
// functions over plain rows - no database, no clock - so they can be
// unit-tested without a running mff-core.
//
// A sample is { method, hardware, totalLen, runSeconds, outcome }. For one
// job of a given length the estimate is the spread (25th/50th/90th
// percentile) of the durations of the nearest-sized finished samples. A run
// is combined from length bins instead of single jobs, because a pulldown
// can hold hundreds of millions of pairs (see sequenceStats.js, which counts
// them without listing them).
//
// Nothing is invented: with fewer than MIN_SAMPLES finished samples there is
// no estimate, and a job larger or smaller than anything measured is flagged
// so the figures read as a lower bound rather than a prediction.

const MIN_SAMPLES = 5;
const GOOD_SAMPLES = 30;
const NEIGHBOURS = 15;
const BIN_COUNT = 40;
// A length more than this factor beyond the measured range counts as outside it.
const EXTRAPOLATION_FACTOR = 1.25;
// Above this share of jobs outside the measured range, confidence drops to "low".
const EXTRAPOLATED_SHARE_LIMIT = 0.1;

// Linear-interpolated quantile of an ascending array.
function quantile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// The (up to) k samples whose totalLen is nearest `length`, by ratio, from
// an array sorted ascending by totalLen. Two pointers walk outwards from the
// insertion point.
function nearest(sortedRows, length, k) {
  let lo = 0;
  let hi = sortedRows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedRows[mid].totalLen < length) lo = mid + 1;
    else hi = mid;
  }
  let left = lo - 1;
  let right = lo;
  const picked = [];
  const distance = row => Math.abs(Math.log(row.totalLen / length));
  while (picked.length < k && (left >= 0 || right < sortedRows.length)) {
    const takeLeft = right >= sortedRows.length || (left >= 0 && distance(sortedRows[left]) <= distance(sortedRows[right]));
    picked.push(takeLeft ? sortedRows[left--] : sortedRows[right++]);
  }
  return picked;
}

const byLength = (a, b) => a.totalLen - b.totalLen;
const isFinished = row => row.outcome === 'ok';

function matches(row, profile) {
  return (profile.method === undefined || row.method === profile.method)
    && (profile.hardware === undefined || row.hardware === profile.hardware);
}

// Which samples to learn from. First those matching the profile exactly;
// when too few have finished, the same method on other hardware. Returns
// null when neither has enough.
function selectClass(samples, profile) {
  const attempts = [{ tier: 'exact', rows: samples.filter(r => matches(r, profile)) }];
  if (profile.hardware !== undefined) {
    attempts.push({ tier: 'method', rows: samples.filter(r => matches(r, { method: profile.method })) });
  }
  for (const attempt of attempts) {
    const finished = attempt.rows.filter(isFinished).sort(byLength);
    if (finished.length >= MIN_SAMPLES) {
      return { tier: attempt.tier, finished, all: attempt.rows.slice().sort(byLength) };
    }
  }
  return null;
}

// Duration spread for one job of this length, from the nearest finished
// samples, plus how often similar-sized jobs did not finish.
function estimateJob(cls, length) {
  const seconds = nearest(cls.finished, length, NEIGHBOURS).map(r => r.runSeconds).sort((a, b) => a - b);
  const similar = nearest(cls.all, length, NEIGHBOURS);
  const min = cls.finished[0].totalLen;
  const max = cls.finished[cls.finished.length - 1].totalLen;
  return {
    p25: quantile(seconds, 0.25),
    p50: quantile(seconds, 0.5),
    p90: quantile(seconds, 0.9),
    failedShare: similar.filter(r => !isFinished(r)).length / similar.length,
    extrapolated: length > max * EXTRAPOLATION_FACTOR || length < min / EXTRAPOLATION_FACTOR
  };
}

// Splits the complexes into about BIN_COUNT groups of similar length (the
// edges are geometric between the shortest and the longest). Returns
// [{ length, count }] where length is the middle of the group.
function lengthBins(complexes, binCount = BIN_COUNT) {
  if (!complexes || complexes.count === 0) return [];
  const { min, max } = complexes;
  const edges = [];
  for (let i = 1; i <= binCount; i += 1) {
    const edge = i === binCount ? max : Math.ceil(min * Math.pow(max / min, i / binCount));
    if (edges.length === 0 || edge > edges[edges.length - 1]) edges.push(edge);
  }
  const bins = [];
  let lower = min - 1;
  let seen = 0;
  edges.forEach(upper => {
    const reached = complexes.atMost(upper);
    const count = reached - seen;
    if (count > 0) bins.push({ length: Math.sqrt((lower + 1) * upper), count });
    seen = reached;
    lower = upper;
  });
  return bins;
}

function confidenceFor(samples, tier, extrapolatedShare) {
  let level = samples >= GOOD_SAMPLES ? 'good' : 'low';
  if (tier !== 'exact' || extrapolatedShare > EXTRAPOLATED_SHARE_LIMIT) level = 'low';
  return level;
}

// samples: rows as described above. profile: { method?, hardware? } - an
// omitted field matches anything. complexes: the object from
// describeComplexes/describeProteins (or null). slots: how many jobs run at
// once. unitsPerJob: CPUs or GPUs one job holds, for the resource-hours.
//
// Work is the sum of every job's duration. "typical" uses each job's median,
// "slow" its 90th percentile - an upper figure, not a likely one, since
// jobs are rarely all slow. Wall time is whichever is longer: the work
// spread over the slots, or the single longest job.
function estimateRun({ samples, profile = {}, complexes, slots = 1, unitsPerJob = 1 }) {
  if (!complexes || complexes.count === 0) return { available: false, reason: 'empty' };
  const cls = selectClass(samples, profile);
  if (!cls) {
    const finished = samples.filter(r => matches(r, profile) && isFinished(r)).length;
    return { available: false, reason: 'no-data', samples: finished, needed: MIN_SAMPLES };
  }

  const parallel = Math.max(1, slots);
  const work = { typical: 0, slow: 0 };
  let extrapolatedJobs = 0;
  let expectedFailures = 0;
  lengthBins(complexes).forEach(bin => {
    const job = estimateJob(cls, bin.length);
    work.typical += bin.count * job.p50;
    work.slow += bin.count * job.p90;
    expectedFailures += bin.count * job.failedShare;
    if (job.extrapolated) extrapolatedJobs += bin.count;
  });

  const longest = estimateJob(cls, complexes.max);
  const extrapolatedShare = extrapolatedJobs / complexes.count;
  const round = Math.round;
  return {
    available: true,
    confidence: confidenceFor(cls.finished.length, cls.tier, extrapolatedShare),
    tier: cls.tier,
    samples: cls.finished.length,
    jobs: complexes.count,
    // true when some jobs are outside the measured sizes: figures are a floor
    lowerBound: extrapolatedJobs > 0,
    extrapolatedShare,
    failedShare: expectedFailures / complexes.count,
    longestJobSeconds: { typical: round(longest.p50), slow: round(longest.p90) },
    workSeconds: { typical: round(work.typical), slow: round(work.slow) },
    wallSeconds: {
      typical: round(Math.max(work.typical / parallel, longest.p50)),
      slow: round(Math.max(work.slow / parallel, longest.p90))
    },
    resourceHours: {
      typical: (work.typical * unitsPerJob) / 3600,
      slow: (work.slow * unitsPerJob) / 3600
    },
    slots: parallel
  };
}

module.exports = { MIN_SAMPLES, GOOD_SAMPLES, NEIGHBOURS, quantile, nearest, lengthBins, selectClass, estimateJob, estimateRun };
