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

test('options default sensibly and every bad value is named', () => {
  assert.deepStrictEqual(
    [OPTIONS.seeds, OPTIONS.gpuCount, OPTIONS.mmseqs2, OPTIONS.templates, OPTIONS.reuseMsa, OPTIONS.limit, OPTIONS.baits],
    [1, 1, 'default', false, false, null, null]
  );
  assert.strictEqual(plan.normaliseOptions({ seeds: 0 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ seeds: 21 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ gpuCount: 9 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ mmseqs2: 'maybe' }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ limit: 0 }).errors.length, 1);
  assert.strictEqual(plan.normaliseOptions({ baits: 'B1' }).errors.length, 1);
  assert.deepStrictEqual(plan.normaliseOptions({ seeds: 3, baits: ['B1'], limit: '5' }).options.baits, ['B1']);
});

test('the profile labels are valid sample labels and differ when the work differs', () => {
  const a = plan.foldProfile(OPTIONS);
  const b = plan.foldProfile({ ...OPTIONS, seeds: 5, templates: true, reuseMsa: true, mmseqs2: 'yes', gpuCount: 2 });
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

test('all-vs-all lists unordered pairs of different proteins; a homo-oligomer folds each alone', () => {
  const all = [row('all', 'X', 10), row('all', 'Y', 20), row('all', 'Z', 30, 3)];
  const pairs = [...plan.enumeratePairs('all_vs_all', all, null)];
  assert.deepStrictEqual(pairs.map(p => `${p.bait.name}${p.cand.name}`), ['XY', 'XZ', 'YZ']);
  assert.strictEqual(plan.countSelection('all_vs_all', all, null), 3);
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

test('chain ids run A..Z then AA', () => {
  assert.deepStrictEqual([0, 1, 25, 26, 27, 51, 52].map(plan.chainId), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
});

test('the ABCFold body: one chain per copy, seeds, options, and a safe name', () => {
  const pair = [...plan.enumeratePairs('pulldown', PULLDOWN, null)][3]; // B2 (2 copies) with C1
  const body = plan.buildJobBody({ projectNumber: 7, pair, options: { ...OPTIONS, seeds: 3, templates: true, gpuCount: 2, mmseqs2: 'yes' } });
  assert.strictEqual(body.name, 'ap-P7-B2-C1');
  assert.deepStrictEqual(body.sequences.map(s => s.id), ['A', 'B', 'C']);
  assert.deepStrictEqual(body.sequences.map(s => s.sequence.length), [200, 200, 50]);
  assert.deepStrictEqual(body.modelSeeds, [1, 2, 3]);
  assert.deepStrictEqual([body.models, body.templates, body.gpuCount, body.mmseqs2], [['alphafold3'], true, 2, true]);
  assert.ok(body.sequences.every(s => s.unpairedMsaPath === undefined));
  assert.ok(!('mmseqs2' in plan.buildJobBody({ projectNumber: 7, pair, options: OPTIONS })), 'default leaves it to the ABCFold module');
  assert.strictEqual(plan.buildJobBody({ projectNumber: 7, pair, options: { ...OPTIONS, mmseqs2: 'no' } }).mmseqs2, false);
  const weird = { bait: { name: 'a b/c', copies: 1, sequence: 'M' }, cand: null };
  assert.match(plan.jobName(1, weird), /^[A-Za-z0-9_.-]+$/);
});

test('MSA reuse passes a path only for a protein that has one, and only when asked', () => {
  const pair = [...plan.enumeratePairs('pulldown', PULLDOWN, null)][3];
  const paths = { B2: '/ws/features/B2.a3m' };
  const off = plan.buildJobBody({ projectNumber: 1, pair, options: OPTIONS, msaPathFor: n => paths[n] || null });
  assert.ok(off.sequences.every(s => s.unpairedMsaPath === undefined));
  const on = plan.buildJobBody({ projectNumber: 1, pair, options: { ...OPTIONS, reuseMsa: true }, msaPathFor: n => paths[n] || null });
  assert.deepStrictEqual(on.sequences.map(s => s.unpairedMsaPath), ['/ws/features/B2.a3m', '/ws/features/B2.a3m', undefined]);
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
