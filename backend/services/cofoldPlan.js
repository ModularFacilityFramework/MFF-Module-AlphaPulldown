// What one co-folding run is: which pairs, what each pair's ABCFold job looks
// like, and how an item's end state becomes an anonymised speed sample. Pure
// functions - no database, no disk, no ABCFold - so they are unit-tested
// without a running mff-core.
//
// A run is one ABCFold job per pair (a bait with a candidate; a homo-oligomer
// folds one protein alone). Pairs are listed lazily - a pulldown of a whole
// proteome has far too many to hold - and a run is capped at MAX_PAIRS_PER_RUN.

const { isTerminalState } = require('./msaPlan');

const MAX_PAIRS_PER_RUN = 5000;
// Planning lists every pair of the selection once to subtract the ones already
// folded, so the selection itself is bounded too.
const MAX_PAIRS_TO_PLAN = 100000;
const MAX_SEEDS = 20;
const MAX_GPUS = 8;
const MAX_SUBMIT_ATTEMPTS = 3;
const MMSEQS2_CHOICES = ['default', 'yes', 'no'];
const LOCAL_STATES = ['QUEUED', 'SUBMITTING', 'SUBMIT_FAILED'];

// A pair is finished (nothing more will happen to it without a retry) when
// Slurm says so, or when it could never be submitted.
function isFinishedState(state) {
  return state === 'SUBMIT_FAILED' || isTerminalState(state);
}

// QUEUED/SUBMITTING are ours; everything else that is not finished is in
// ABCFold's/Slurm's hands.
function isInFlightState(state) {
  return state !== 'QUEUED' && !isFinishedState(state);
}

function firstWord(state) {
  return String(state).trim().split(/[\s+]/)[0].toUpperCase();
}

// The buckets the progress bar shows.
function stateGroup(state) {
  if (state === 'QUEUED') return 'queued';
  if (state === 'SUBMITTING') return 'running';
  const word = firstWord(state);
  if (word === 'COMPLETED') return 'done';
  if (word === 'CANCELLED' || word === 'REVOKED') return 'cancelled';
  if (isFinishedState(state)) return 'failed';
  return 'running';
}

function normaliseOptions(raw) {
  const input = raw || {};
  const errors = [];
  const seeds = input.seeds === undefined ? 1 : Number(input.seeds);
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > MAX_SEEDS) errors.push(`seeds must be a whole number from 1 to ${MAX_SEEDS}`);
  const gpuCount = input.gpuCount === undefined ? 1 : Number(input.gpuCount);
  if (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > MAX_GPUS) errors.push(`gpuCount must be a whole number from 1 to ${MAX_GPUS}`);
  const mmseqs2 = input.mmseqs2 === undefined ? 'default' : input.mmseqs2;
  if (!MMSEQS2_CHOICES.includes(mmseqs2)) errors.push(`mmseqs2 must be one of ${MMSEQS2_CHOICES.join(', ')}`);
  const limit = input.limit === undefined || input.limit === null || input.limit === '' ? null : Number(input.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) errors.push('limit must be a whole number of at least 1');
  if (input.baits !== undefined && input.baits !== null && !Array.isArray(input.baits)) errors.push('baits must be a list of names');
  return {
    errors,
    options: {
      seeds,
      gpuCount,
      mmseqs2,
      templates: !!input.templates,
      reuseMsa: !!input.reuseMsa,
      includeOversize: !!input.includeOversize,
      limit,
      baits: Array.isArray(input.baits) ? input.baits.map(String) : null
    }
  };
}

// The labels a run's speed samples are filed under; they are what the
// estimate for a planned run looks up, so both sides use this one function.
function foldProfile(options) {
  const search = options.mmseqs2 === 'yes' ? 'mmseqs2' : options.mmseqs2 === 'no' ? 'localdb' : 'msadefault';
  const method = `s${options.seeds}-${search}${options.templates ? '-tpl' : ''}${options.reuseMsa ? '-reuse' : ''}`;
  return { method, hardware: `gpu${options.gpuCount}` };
}

// Spreads the same "describe a set of jobs" shape as sequenceStats.js gives
// (count, min, max, total, atMost) over an explicit list of lengths.
function describeLengths(lengths) {
  if (lengths.length === 0) return null;
  const sorted = lengths.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    total: sorted.reduce((acc, v) => acc + v, 0),
    atMost: x => {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }
  };
}

function copiesOf(row) {
  return row.copies > 0 ? row.copies : 1;
}

function partner(row) {
  return { name: row.name, length: row.length, copies: copiesOf(row), sequence: row.sequence };
}

// Every pair the project's mode produces, lazily: { bait, cand, lenA, lenB }.
// bait/cand are { name, length, copies, sequence }; cand is null and lenB null
// for a homo-oligomer. lenA/lenB count every copy. `baits` (a list of names)
// narrows a pulldown to those baits.
function* enumeratePairs(mode, rows, baitNames) {
  if (mode === 'pulldown') {
    const wanted = baitNames ? new Set(baitNames) : null;
    const baits = rows.filter(r => r.role === 'bait' && (!wanted || wanted.has(r.name)));
    const candidates = rows.filter(r => r.role === 'candidate');
    for (const bait of baits) {
      for (const cand of candidates) {
        yield { bait: partner(bait), cand: partner(cand), lenA: bait.length * copiesOf(bait), lenB: cand.length * copiesOf(cand) };
      }
    }
    return;
  }
  const all = rows.filter(r => r.role === 'all');
  if (mode === 'homo_oligomer') {
    for (const row of all) yield { bait: partner(row), cand: null, lenA: row.length * copiesOf(row), lenB: null };
    return;
  }
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      yield { bait: partner(all[i]), cand: partner(all[j]), lenA: all[i].length * copiesOf(all[i]), lenB: all[j].length * copiesOf(all[j]) };
    }
  }
}

// How many pairs a selection holds, without listing them.
function countSelection(mode, rows, baitNames) {
  if (mode === 'pulldown') {
    const wanted = baitNames ? new Set(baitNames) : null;
    const baits = rows.filter(r => r.role === 'bait' && (!wanted || wanted.has(r.name))).length;
    return baits * rows.filter(r => r.role === 'candidate').length;
  }
  const listed = rows.filter(r => r.role === 'all').length;
  return mode === 'homo_oligomer' ? listed : (listed * (listed - 1)) / 2;
}

const pairKey = (bait, cand) => `${bait}\u0000${cand === null || cand === undefined ? '' : cand}`;

// The pairs a new run would fold: the selection, minus the ones that already
// completed, minus the ones too large unless asked, then at most `limit`.
// Stops listing once it has more than MAX_PAIRS_PER_RUN so a huge selection is
// reported rather than held. Returns the numbers the plan shows alongside.
function selectPairs({ mode, rows, options, completed, limitAA }) {
  const selected = countSelection(mode, rows, options.baits);
  const result = { selected, alreadyDone: 0, oversize: 0, pairs: [], tooMany: false };
  if (selected === 0) return result;
  const cap = options.limit ? Math.min(options.limit, MAX_PAIRS_PER_RUN) : MAX_PAIRS_PER_RUN;
  let eligible = 0;
  for (const pair of enumeratePairs(mode, rows, options.baits)) {
    if (completed.has(pairKey(pair.bait.name, pair.cand && pair.cand.name))) {
      result.alreadyDone += 1;
      continue;
    }
    if (limitAA > 0 && pair.lenA + (pair.lenB || 0) > limitAA && !options.includeOversize) {
      result.oversize += 1;
      continue;
    }
    eligible += 1;
    if (result.pairs.length < cap) result.pairs.push(pair);
  }
  result.eligible = eligible;
  result.tooMany = !options.limit && eligible > MAX_PAIRS_PER_RUN;
  return result;
}

// Chain ids A, B, ... Z, AA, AB, ...
function chainId(index) {
  let id = '';
  let n = index;
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

// A name the ABCFold module and the file system will both accept.
function jobName(projectNumber, pair) {
  const parts = [`ap-P${projectNumber}`, pair.bait.name].concat(pair.cand ? [pair.cand.name] : []);
  return parts.join('-').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
}

// The body for the ABCFold module's POST /jobs (see abcfoldClient.js for the
// contract this assumes). msaPathFor(name) returns an A3M path or null; it is
// only consulted when the run reuses MSAs, and the field is simply left out
// for a protein without one.
function buildJobBody({ projectNumber, pair, options, msaPathFor }) {
  const sequences = [];
  [pair.bait, pair.cand].filter(Boolean).forEach(p => {
    const msaPath = options.reuseMsa && msaPathFor ? msaPathFor(p.name) : null;
    for (let copy = 0; copy < p.copies; copy += 1) {
      const entry = { type: 'protein', id: chainId(sequences.length), sequence: p.sequence };
      if (msaPath) entry.unpairedMsaPath = msaPath;
      sequences.push(entry);
    }
  });
  const body = {
    name: jobName(projectNumber, pair),
    sequences,
    modelSeeds: Array.from({ length: options.seeds }, (_, i) => i + 1),
    models: ['alphafold3'],
    templates: options.templates,
    gpuCount: options.gpuCount
  };
  if (options.mmseqs2 !== 'default') body.mmseqs2 = options.mmseqs2 === 'yes';
  return body;
}

// How an item's end state files its sample: null = no sample (cancelled, never
// submitted, or no usable timestamps).
function foldOutcome(state) {
  const word = firstWord(state);
  if (word === 'COMPLETED') return 'ok';
  if (word === 'OUT_OF_MEMORY') return 'oom';
  if (word === 'TIMEOUT') return 'timeout';
  if (['CANCELLED', 'REVOKED', 'PREEMPTED'].includes(word) || LOCAL_STATES.includes(state)) return null;
  return isTerminalState(state) ? 'failed' : null;
}

function seconds(from, to) {
  if (!from || !to) return null;
  const value = Math.round((new Date(to) - new Date(from)) / 1000);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// items: [{ state, lenA, lenB, startedAt, endedAt, slurmSubmittedAt }] ->
// samples for speedRecorder.recordSamples. Carries lengths, labels, seconds
// and an outcome only - never a name or an id.
function samplesFromItems(items, { method, hardware }) {
  const samples = [];
  items.forEach(item => {
    const outcome = foldOutcome(item.state);
    const runSeconds = seconds(item.startedAt, item.endedAt);
    if (!outcome || runSeconds === null) return;
    samples.push({
      stage: 'fold',
      lenA: item.lenA,
      lenB: item.lenB === null || item.lenB === undefined ? null : item.lenB,
      method,
      hardware,
      outcome,
      runSeconds,
      queueSeconds: seconds(item.slurmSubmittedAt, item.startedAt)
    });
  });
  return samples;
}

module.exports = {
  MAX_PAIRS_PER_RUN,
  MAX_PAIRS_TO_PLAN,
  MAX_SUBMIT_ATTEMPTS,
  LOCAL_STATES,
  isFinishedState,
  isInFlightState,
  stateGroup,
  normaliseOptions,
  foldProfile,
  describeLengths,
  enumeratePairs,
  countSelection,
  pairKey,
  selectPairs,
  chainId,
  jobName,
  buildJobBody,
  foldOutcome,
  samplesFromItems
};
