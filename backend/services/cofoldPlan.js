// What one prediction run is: which complexes, what each complex's Slurm job
// looks like, and how an item's end state becomes an anonymised speed sample.
// Pure functions - no database, no disk, no Slurm - so they are unit-tested
// without a running mff-core.
//
// A run is one Slurm job per complex, each running AlphaPulldown's
// run_multimer_jobs.py with the AlphaFold 3 backend on the features the
// Features tab made. A complex is a bait with a candidate (pulldown), two
// proteins of one list (all-versus-all, including a protein with itself) or a
// homo-oligomer folded alone. Complexes are listed lazily - a pulldown of a
// whole proteome has far too many to hold - and a run is capped at
// MAX_PAIRS_PER_RUN.

const { isTerminalState, shellQuote, activationLines } = require('./msaPlan');
const { foldHardware } = require('./speedProfiles');

const MAX_PAIRS_PER_RUN = 5000;
// Planning lists every pair of the selection once to subtract the ones already
// folded, so the selection itself is bounded too.
const MAX_PAIRS_TO_PLAN = 100000;
const MAX_SEEDS = 20;
const MAX_SAMPLES = 20;
const MAX_RECYCLES = 30;
const MAX_SUBMIT_ATTEMPTS = 3;
const LOCAL_STATES = ['QUEUED', 'SUBMITTING', 'SUBMIT_FAILED'];

// A pair is finished (nothing more will happen to it without a retry) when
// Slurm says so, or when it could never be submitted.
function isFinishedState(state) {
  return state === 'SUBMIT_FAILED' || isTerminalState(state);
}

// QUEUED/SUBMITTING are ours; everything else that is not finished is in
// Slurm's hands.
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

// The AlphaFold 3 options of a run, with AlphaFold 3's own defaults: one seed,
// 5 diffusion samples (so 5 models per seed), 10 recycles.
function normaliseOptions(raw) {
  const input = raw || {};
  const errors = [];
  function whole(key, fallback, max, label) {
    const value = input[key] === undefined || input[key] === null || input[key] === '' ? fallback : Number(input[key]);
    if (!Number.isInteger(value) || value < 1 || value > max) errors.push(`${label} must be a whole number from 1 to ${max}`);
    return value;
  }
  const seeds = whole('seeds', 1, MAX_SEEDS, 'seeds');
  const samples = whole('samples', 5, MAX_SAMPLES, 'diffusion samples');
  const recycles = whole('recycles', 10, MAX_RECYCLES, 'recycles');
  const limit = input.limit === undefined || input.limit === null || input.limit === '' ? null : Number(input.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) errors.push('limit must be a whole number of at least 1');
  if (input.baits !== undefined && input.baits !== null && !Array.isArray(input.baits)) errors.push('baits must be a list of names');
  return {
    errors,
    options: {
      seeds,
      samples,
      recycles,
      includeOversize: !!input.includeOversize,
      limit,
      baits: Array.isArray(input.baits) ? input.baits.map(String) : null
    }
  };
}

// The labels a run's speed samples are filed under; they are what the
// estimate for a planned run looks up, so both sides use this one function.
// 'af3-s1-d5-r10' = AlphaFold 3, 1 seed, 5 diffusion samples, 10 recycles.
function foldProfile(options, settings) {
  return {
    method: `af3-s${options.seeds}-d${options.samples}-r${options.recycles}`,
    hardware: foldHardware(settings)
  };
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

// Every complex the project's mode produces, lazily: { bait, cand, lenA, lenB }.
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
  // all_vs_all: every unordered pair of the list, a protein with itself
  // included (AlphaPulldown's own definition: A+A, A+B, B+B, ...).
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i; j < all.length; j += 1) {
      yield { bait: partner(all[i]), cand: partner(all[j]), lenA: all[i].length * copiesOf(all[i]), lenB: all[j].length * copiesOf(all[j]) };
    }
  }
}

// How many complexes a selection holds, without listing them.
function countSelection(mode, rows, baitNames) {
  if (mode === 'pulldown') {
    const wanted = baitNames ? new Set(baitNames) : null;
    const baits = rows.filter(r => r.role === 'bait' && (!wanted || wanted.has(r.name))).length;
    return baits * rows.filter(r => r.role === 'candidate').length;
  }
  const listed = rows.filter(r => r.role === 'all').length;
  return mode === 'homo_oligomer' ? listed : (listed * (listed + 1)) / 2;
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

// One protein of a complex as AlphaPulldown's list files write it: the name,
// or name:copies for a homo-oligomer state.
function proteinSpec(p) {
  return p.copies > 1 ? `${p.name}:${p.copies}` : p.name;
}

// The line of fold_input.txt: the proteins of one complex joined with the
// default protein delimiter "+" (AlphaPulldown's custom-mode syntax).
function foldSpec(pair) {
  return [pair.bait, pair.cand].filter(Boolean).map(proteinSpec).join('+');
}

// The arguments of one run_multimer_jobs.py call. --num_cycle is the wrapper's
// name for AlphaFold 3's --num_recycles. The job's own output folder keeps
// every complex's results apart (AlphaPulldown adds one sub-folder per fold).
function foldArgs(settings, options, { featuresDir, outputDir, cacheDir }) {
  return [
    '--mode=custom',
    '--protein_lists=fold_input.txt',
    `--monomer_objects_dir=${shellQuote(featuresDir)}`,
    `--output_path=${shellQuote(outputDir)}`,
    `--data_dir=${shellQuote(settings.weights_dir)}`,
    '--fold_backend=alphafold3',
    `--num_seeds=${options.seeds}`,
    `--num_diffusion_samples=${options.samples}`,
    `--num_cycle=${options.recycles}`,
    `--jax_compilation_cache_dir=${shellQuote(cacheDir)}`
  ];
}

// The sbatch script of one complex. slug: a single dash-separated token (sbatch
// splits directive values on whitespace).
function buildSubmitScript({ slug, settings, email, options, featuresDir, outputDir, cacheDir }) {
  const lines = [
    // -i: needed for the micromamba/conda shell hook below to define its
    // shell function; non-interactive bash skips that setup.
    '#!/bin/bash -i',
    `#SBATCH --job-name=${slug}`,
    '#SBATCH --nodes=1',
    '#SBATCH --ntasks=1'
  ];
  if (settings.fold_partition) lines.push(`#SBATCH --partition=${settings.fold_partition}`);
  if (settings.fold_gres) lines.push(`#SBATCH --gres=${settings.fold_gres}`);
  lines.push(
    `#SBATCH --cpus-per-task=${settings.fold_cpus_per_task}`,
    `#SBATCH --mem=${settings.fold_mem}`,
    `#SBATCH --time=${settings.fold_time}`,
    '#SBATCH --output=slurm.out',
    '#SBATCH --error=slurm.err'
  );
  if (email) {
    lines.push(`#SBATCH --mail-user=${email}`);
    if (settings.slurm_mail_type) lines.push(`#SBATCH --mail-type=${settings.slurm_mail_type}`);
  }
  // After the activation: conda's own activation scripts are not written for
  // set -u.
  lines.push('', ...activationLines(settings), '', 'set -euo pipefail', '');
  if (settings.fold_unified_memory) {
    lines.push(
      '# AlphaFold 3\'s recommendation for GPUs whose memory a large complex can fill:',
      '# let it spill into host memory (slower, but it finishes).',
      'export XLA_PYTHON_CLIENT_PREALLOCATE=false',
      'export TF_FORCE_UNIFIED_MEMORY=true',
      'export XLA_CLIENT_MEM_FRACTION=3.2',
      ''
    );
  }
  lines.push(
    `mkdir -p ${shellQuote(cacheDir)}`,
    'run_multimer_jobs.py \\',
    ...foldArgs(settings, options, { featuresDir, outputDir, cacheDir }).map((arg, i, all) => `  ${arg}${i < all.length - 1 ? ' \\' : ''}`),
    ''
  );
  return lines.join('\n');
}

// Everything written into one complex's folder, as { name: content }.
function buildFoldFiles({ slug, settings, email, options, pair, featuresDir, outputDir, cacheDir }) {
  return {
    'submit.sh': buildSubmitScript({ slug, settings, email, options, featuresDir, outputDir, cacheDir }),
    'fold_input.txt': `${foldSpec(pair)}\n`
  };
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
  proteinSpec,
  foldSpec,
  foldArgs,
  buildSubmitScript,
  buildFoldFiles,
  foldOutcome,
  samplesFromItems
};
