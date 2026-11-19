const test = require('node:test');
const assert = require('node:assert');
const plan = require('./cofoldPlan');
const { sanitiseSample } = require('./speedRecorder');

const row = (role, name, length, copies = 1) => ({ role, name, length, copies, sequence: 'M'.repeat(length) });
const PULLDOWN = [
  row('bait', 'B1', 100), row('bait', 'B2', 200, 2),
  row('candidate', 'C1', 50), row('candidate', 'C2', 60), row('candidate', 'C3', 70)
];
const OPTIONS = plan.normaliseOptions({}).options;

const SETTINGS = {
  slurm_mail_type: 'END,FAIL',
  env_manager: 'micromamba',
  env_name: 'alphafold3_alphapulldown',
  weights_dir: '/models/af3',
  fold_partition: 'gpu',
  fold_gres: 'gpu:1',
  fold_cpus_per_task: 8,
  fold_mem: '64G',
  fold_time: '24:00:00',
  fold_unified_memory: 1
};
const PATHS = { featuresDir: '/ws/P1/features', outputDir: '/ws/P1/predictions/run-3/job-9/output', cacheDir: '/ws/P1/predictions/jax-cache' };

test('options default to AlphaFold 3\'s own and every bad value is named', () => {
  assert.deepStrictEqual(
    [OPTIONS.seeds, OPTIONS.samples, OPTIONS.recycles, OPTIONS.includeOversize, OPTIONS.limit, OPTIONS.baits],
    [1, 5, 10, false, null, null]
  );
  assert.strictEqual(plan.normaliseOptions({ seeds: 0 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ seeds: 21 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ samples: 21 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ recycles: 0 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ recycles: '3' }).options.recycles, 3);
  assert.strictEqual(plan.normaliseOptions({ limit: 0 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ baits: 'B1' }).errors.length, 1);
  assert.deepStrictEqual(plan.normaliseOptions({ seeds: 3, baits: ['B1'], limit: '5' }).options.baits, ['B1']);
});

test('the profile labels are valid sample labels and differ when the work differs', () => {
  const a = plan.foldProfile(OPTIONS, SETTINGS);
  const b = plan.foldProfile({ ...OPTIONS, seeds: 5, samples: 1, recycles: 3 }, { ...SETTINGS, fold_gres: 'gpu:rtx_a5000:1' });
  assert.deepStrictEqual(a, { method: 'af3-s1-d5-r10', hardware: 'gpu/gpu-1' });
  assert.strictEqual(b.hardware, 'gpu/gpu-rtx_a5000-1');
  assert.notDeepStrictEqual(a, b);
  [a, b].forEach(p => assert.ok(sanitiseSample({ stage: 'fold', lenA: 10, lenB: 10, outcome: 'ok', runSeconds: 1, ...p }, '2026-01-01'), JSON.stringify(p)));
});

test('a pulldown lists every bait with every candidate, copies counted in the lengths', () => {
  const pairs = [...plan.enumeratePairs('pulldown', PULLDOWN, null)];
  assert.strictEqual(pairs.length, 6);
  assert.deepStrictEqual(pairs.map(p => [p.bait.name, p.cand.name]), [['B1', 'C1'], ['B1', 'C2'], ['B1', 'C3'], ['B2', 'C1'], ['B2', 'C2'], ['B2', 'C3']]);
  assert.deepStrictEqual([pairs[3].lenA, pairs[3].lenB], [400, 50]);
  assert.strictEqual(plan.countSelection('pulldown', PULLDOWN, null), 6);
  assert.strictEqual(plan.countSelection('pulldown', PULLDOWN, ['B2']), 3);
  assert.strictEqual([...plan.enumeratePairs('pulldown', PULLDOWN, ['B2'])].length, 3);
  assert.strictEqual(plan.countSelection('pulldown', PULLDOWN, ['nope']), 0);
});

test('all-vs-all lists unordered pairs, a protein with itself included; a homo-oligomer folds each alone', () => {
  const all = [row('all', 'X', 10), row('all', 'Y', 20), row('all', 'Z', 30, 3)];
  const pairs = [...plan.enumeratePairs('all_vs_all', all, null)];
  assert.deepStrictEqual(pairs.map(p => `${p.bait.name}${p.cand.name}`), ['XX', 'XY', 'XZ', 'YY', 'YZ', 'ZZ']);
  assert.strictEqual(plan.countSelection('all_vs_all', all, null), 6);
  assert.deepStrictEqual([pairs[5].lenA, pairs[5].lenB], [90, 90]);
  const homo = [...plan.enumeratePairs('homo_oligomer', all, null)];
  assert.deepStrictEqual(homo.map(p => [p.bait.name, p.cand, p.lenA, p.lenB]), [['X', null, 10, null], ['Y', null, 20, null], ['Z', null, 90, null]]);
  assert.strictEqual(plan.countSelection('homo_oligomer', all, null), 3);
});

test('the count agrees with the listing and with the stats strip numbers', () => {
  const { describeComplexes } = require('./sequenceStats');
  const listed = [...plan.enumeratePairs('pulldown', PULLDOWN, null)];
  const described = describeComplexes('pulldown', PULLDOWN);
  assert.strictEqual(described.count, listed.length);
  assert.strictEqual(described.total, listed.reduce((acc, p) => acc + p.lenA + p.lenB, 0));
});

test('selecting pairs drops finished and oversize ones and honours the limit', () => {
  const completed = new Set([plan.pairKey('B1', 'C1')]);
  let sel = plan.selectPairs({ mode: 'pulldown', rows: PULLDOWN, options: OPTIONS, completed, limitAA: 0 });
  assert.deepStrictEqual([sel.selected, sel.alreadyDone, sel.oversize, sel.pairs.length], [6, 1, 0, 5]);

  sel = plan.selectPairs({ mode: 'pulldown', rows: PULLDOWN, options: OPTIONS, completed, limitAA: 200 });
  assert.strictEqual(sel.oversize, 3, 'B2 with its two copies is 400 aa');
  assert.strictEqual(sel.pairs.length, 2);
  sel = plan.selectPairs({ mode: 'pulldown', rows: PULLDOWN, options: { ...OPTIONS, includeOversize: true }, completed, limitAA: 200 });
  assert.strictEqual(sel.pairs.length, 5);

  sel = plan.selectPairs({ mode: 'pulldown', rows: PULLDOWN, options: { ...OPTIONS, limit: 2 }, completed: new Set(), limitAA: 0 });
  assert.deepStrictEqual([sel.pairs.length, sel.eligible, sel.tooMany], [2, 6, false]);
});

test('a selection beyond one run is reported, not silently cut', () => {
  const baits = Array.from({ length: 60 }, (_, i) => row('bait', `B${i}`, 10));
  const candidates = Array.from({ length: 100 }, (_, i) => row('candidate', `C${i}`, 10));
  const sel = plan.selectPairs({ mode: 'pulldown', rows: baits.concat(candidates), options: OPTIONS, completed: new Set(), limitAA: 0 });
  assert.strictEqual(sel.tooMany, true);
  assert.strictEqual(sel.eligible, 6000);
  assert.strictEqual(sel.pairs.length, plan.MAX_PAIRS_PER_RUN);
});

test('a complex is written the way AlphaPulldown reads a protein list', () => {
  const [, , , fourth] = [...plan.enumeratePairs('pulldown', PULLDOWN, null)]; // B2 (2 copies) with C1
  assert.strictEqual(plan.foldSpec(fourth), 'B2:2+C1');
  assert.strictEqual(plan.foldSpec([...plan.enumeratePairs('pulldown', PULLDOWN, null)][0]), 'B1+C1');
  const homo = [...plan.enumeratePairs('homo_oligomer', [row('all', 'Z', 30, 3)], null)][0];
  assert.strictEqual(plan.foldSpec(homo), 'Z:3');
});

test('the run_multimer_jobs.py call: custom list, AlphaFold 3 backend, seeds, samples, recycles', () => {
  const args = plan.foldArgs(SETTINGS, { seeds: 3, samples: 2, recycles: 7 }, PATHS);
  assert.deepStrictEqual(args, [
    '--mode=custom',
    '--protein_lists=fold_input.txt',
    '--monomer_objects_dir=\'/ws/P1/features\'',
    '--output_path=\'/ws/P1/predictions/run-3/job-9/output\'',
    '--data_dir=\'/models/af3\'',
    '--fold_backend=alphafold3',
    '--num_seeds=3',
    '--num_diffusion_samples=2',
    '--num_cycle=7',
    '--jax_compilation_cache_dir=\'/ws/P1/predictions/jax-cache\''
  ]);
});

test('the job folder holds the one-line list and an sbatch script that activates, then runs', () => {
  const pair = [...plan.enumeratePairs('pulldown', PULLDOWN, null)][3];
  const files = plan.buildFoldFiles({ slug: 'ap-P1-fold-9', settings: SETTINGS, email: 'a@b.c', options: OPTIONS, pair, ...PATHS });
  assert.deepStrictEqual(Object.keys(files), ['submit.sh', 'fold_input.txt']);
  assert.strictEqual(files['fold_input.txt'], 'B2:2+C1\n');
  const lines = files['submit.sh'].split('\n');
  assert.strictEqual(lines[0], '#!/bin/bash -i');
  ['#SBATCH --job-name=ap-P1-fold-9', '#SBATCH --partition=gpu', '#SBATCH --gres=gpu:1', '#SBATCH --cpus-per-task=8',
    '#SBATCH --mem=64G', '#SBATCH --time=24:00:00', '#SBATCH --output=slurm.out', '#SBATCH --error=slurm.err',
    '#SBATCH --mail-user=a@b.c', '#SBATCH --mail-type=END,FAIL'].forEach(l => assert.ok(lines.includes(l), l));
  const at = text => lines.findIndex(l => l.includes(text));
  assert.ok(at('micromamba activate alphafold3_alphapulldown') > 0);
  assert.ok(at('set -euo pipefail') > at('micromamba activate'), 'strict mode only after the environment is active');
  assert.ok(at('run_multimer_jobs.py') > at('set -euo pipefail'));
  assert.ok(files['submit.sh'].includes('export TF_FORCE_UNIFIED_MEMORY=true'));
  assert.ok(files['submit.sh'].includes('  --fold_backend=alphafold3 \\\n'));
  assert.ok(!files['submit.sh'].endsWith(' \\\n'), 'the last argument carries no line continuation');
});

test('the script follows the settings: no GPU line, no mail, conda, no unified memory', () => {
  const pair = [...plan.enumeratePairs('pulldown', PULLDOWN, null)][0];
  const text = plan.buildFoldFiles({
    slug: 's', settings: { ...SETTINGS, fold_gres: '', fold_partition: '', env_manager: 'conda', fold_unified_memory: 0 },
    email: '', options: OPTIONS, pair, ...PATHS
  })['submit.sh'];
  assert.ok(!text.includes('--gres') && !text.includes('--partition') && !text.includes('--mail') && !text.includes('UNIFIED'));
  assert.ok(text.includes('conda activate alphafold3_alphapulldown'));
});

test('states fall into the progress groups and the finished ones are known', () => {
  const groups = { QUEUED: 'queued', SUBMITTING: 'running', PENDING: 'running', RUNNING: 'running', COMPLETED: 'done', FAILED: 'failed', TIMEOUT: 'failed', OUT_OF_MEMORY: 'failed', SUBMIT_FAILED: 'failed', 'CANCELLED by 5': 'cancelled' };
  Object.entries(groups).forEach(([state, group]) => assert.strictEqual(plan.stateGroup(state), group, state));
  assert.ok(plan.isFinishedState('SUBMIT_FAILED') && plan.isFinishedState('COMPLETED') && !plan.isFinishedState('QUEUED') && !plan.isFinishedState('RUNNING'));
  assert.ok(plan.isInFlightState('SUBMITTING') && plan.isInFlightState('PENDING') && !plan.isInFlightState('QUEUED') && !plan.isInFlightState('FAILED'));
});

test('speed samples: outcome from the end state, seconds from the timestamps, no names', () => {
  const at = s => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const items = [
    { state: 'COMPLETED', lenA: 100, lenB: 50, slurmSubmittedAt: at(0), startedAt: at(30), endedAt: at(330), bait: 'SECRET' },
    { state: 'OUT_OF_MEMORY', lenA: 400, lenB: 50, startedAt: at(0), endedAt: at(60) },
    { state: 'TIMEOUT', lenA: 100, lenB: null, startedAt: at(0), endedAt: at(90) },
    { state: 'FAILED', lenA: 100, lenB: 50, startedAt: at(0), endedAt: at(10) },
    { state: 'CANCELLED', lenA: 100, lenB: 50, startedAt: at(0), endedAt: at(10) },
    { state: 'COMPLETED', lenA: 100, lenB: 50, startedAt: null, endedAt: at(10) },
    { state: 'SUBMIT_FAILED', lenA: 100, lenB: 50 },
    { state: 'RUNNING', lenA: 100, lenB: 50, startedAt: at(0), endedAt: null }
  ];
  const samples = plan.samplesFromItems(items, { method: 'm', hardware: 'gpu1' });
  assert.deepStrictEqual(samples.map(s => [s.outcome, s.runSeconds, s.queueSeconds, s.lenB]), [
    ['ok', 300, 30, 50], ['oom', 60, null, 50], ['timeout', 90, null, null], ['failed', 10, null, 50]
  ]);
  assert.ok(samples.every(s => s.stage === 'fold' && sanitiseSample(s, '2026-01-01')));
  assert.ok(!JSON.stringify(samples).includes('SECRET'));
});

test('a list of lengths describes itself like the stats numbers do', () => {
  const d = plan.describeLengths([300, 100, 200]);
  assert.deepStrictEqual([d.count, d.min, d.max, d.total, d.atMost(150), d.atMost(300), d.atMost(50)], [3, 100, 300, 600, 1, 3, 0]);
  assert.strictEqual(plan.describeLengths([]), null);
});
