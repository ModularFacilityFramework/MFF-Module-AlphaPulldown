const test = require('node:test');
const assert = require('node:assert');
const { quantile, nearest, lengthBins, estimateRun } = require('./speedEstimator');
const { describeProteins, describeComplexes } = require('./sequenceStats');

const sample = (totalLen, runSeconds, extra = {}) => ({
  method: 'local', hardware: 'cpu/8', totalLen, runSeconds, outcome: 'ok', ...extra
});
// n finished samples between 100 and 500 aa, all taking `seconds`
const flatSamples = (n, seconds, extra = {}) => Array.from({ length: n }, (_, i) => sample(100 + Math.floor((i * 400) / n), seconds, extra));
const proteins = lengths => describeProteins(lengths.map((length, i) => ({ role: 'all', name: `P${i}`, length })));

test('quantile interpolates between neighbours', () => {
  assert.strictEqual(quantile([10], 0.9), 10);
  assert.strictEqual(quantile([10, 20, 30, 40, 50], 0.5), 30);
  assert.strictEqual(quantile([0, 100], 0.25), 25);
  assert.strictEqual(quantile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 90);
});

test('nearest picks the closest lengths by ratio from both sides', () => {
  const rows = [100, 200, 300, 400, 1000].map(l => sample(l, 1));
  assert.deepStrictEqual(nearest(rows, 250, 2).map(r => r.totalLen).sort((a, b) => a - b), [200, 300]);
  assert.deepStrictEqual(nearest(rows, 5000, 2).map(r => r.totalLen).sort((a, b) => a - b), [400, 1000]);
  assert.strictEqual(nearest(rows, 250, 99).length, 5);
});

test('length bins hold every complex exactly once', () => {
  const complexes = proteins([50, 80, 120, 300, 300, 450, 900, 2000, 2000, 2000]);
  const bins = lengthBins(complexes);
  assert.strictEqual(bins.reduce((acc, b) => acc + b.count, 0), 10);
  bins.forEach((b, i) => { if (i > 0) assert.ok(b.length > bins[i - 1].length); });
  assert.ok(bins[0].length >= 50 && bins[bins.length - 1].length <= 2000);
});

test('identical lengths form a single bin', () => {
  assert.deepStrictEqual(lengthBins(proteins([300, 300, 300])), [{ length: 300, count: 3 }]);
});

test('bins work on a pulldown too large to list', () => {
  const rows = [];
  for (let i = 0; i < 20000; i += 1) rows.push({ role: 'candidate', name: `C${i}`, length: 100 + (i % 900), copies: 1 });
  for (let i = 0; i < 20000; i += 1) rows.push({ role: 'bait', name: `B${i}`, length: 100 + (i % 900), copies: 1 });
  const complexes = describeComplexes('pulldown', rows);
  const bins = lengthBins(complexes);
  assert.strictEqual(bins.reduce((acc, b) => acc + b.count, 0), 400000000);
});

test('fewer than five finished samples gives no estimate', () => {
  const result = estimateRun({ samples: flatSamples(4, 100), profile: { method: 'local' }, complexes: proteins([200]) });
  assert.deepStrictEqual(result, { available: false, reason: 'no-data', samples: 4, needed: 5 });
});

test('failed samples do not count towards the five', () => {
  const samples = [...flatSamples(4, 100), sample(300, 50, { outcome: 'oom' })];
  assert.strictEqual(estimateRun({ samples, profile: {}, complexes: proteins([200]) }).available, false);
});

test('nothing to run gives no estimate', () => {
  assert.strictEqual(estimateRun({ samples: flatSamples(10, 100), complexes: null }).reason, 'empty');
});

test('constant timings: work, wall time and resource-hours follow by hand', () => {
  const result = estimateRun({
    samples: flatSamples(10, 100),
    profile: { method: 'local', hardware: 'cpu/8' },
    complexes: proteins([200, 250, 300]),
    slots: 3,
    unitsPerJob: 8
  });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.confidence, 'low');
  assert.strictEqual(result.tier, 'exact');
  assert.strictEqual(result.jobs, 3);
  assert.deepStrictEqual(result.workSeconds, { typical: 300, slow: 300 });
  assert.deepStrictEqual(result.wallSeconds, { typical: 100, slow: 100 });
  assert.deepStrictEqual(result.longestJobSeconds, { typical: 100, slow: 100 });
  assert.ok(Math.abs(result.resourceHours.typical - (300 * 8) / 3600) < 1e-9);
  assert.strictEqual(result.lowerBound, false);
  assert.strictEqual(result.failedShare, 0);
});

test('fewer slots than jobs stretches the wall time; one long job sets a floor', () => {
  const samples = flatSamples(10, 100);
  const one = estimateRun({ samples, profile: {}, complexes: proteins([200, 250, 300]), slots: 1 });
  assert.strictEqual(one.wallSeconds.typical, 300);
  const many = estimateRun({ samples, profile: {}, complexes: proteins([200, 250, 300]), slots: 1000 });
  assert.strictEqual(many.wallSeconds.typical, 100);
});

test('thirty finished samples give good confidence', () => {
  const result = estimateRun({ samples: flatSamples(30, 100), profile: {}, complexes: proteins([200, 300]) });
  assert.strictEqual(result.confidence, 'good');
  assert.strictEqual(result.samples, 30);
});

test('slow case uses the 90th percentile of similar jobs', () => {
  // ten samples at the same length, 10..100 s
  const samples = Array.from({ length: 10 }, (_, i) => sample(300, (i + 1) * 10));
  const result = estimateRun({ samples, profile: {}, complexes: proteins([300]) });
  assert.strictEqual(result.workSeconds.typical, 55);
  assert.strictEqual(result.workSeconds.slow, 91);
});

test('other hardware is used, with low confidence, when this hardware has too few samples', () => {
  const samples = [...flatSamples(40, 100, { hardware: 'cpu/16' }), ...flatSamples(2, 100)];
  const result = estimateRun({ samples, profile: { method: 'local', hardware: 'cpu/8' }, complexes: proteins([200]) });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.tier, 'method');
  assert.strictEqual(result.confidence, 'low');
});

test('a different method is never borrowed', () => {
  const samples = flatSamples(40, 100, { method: 'mmseqs2' });
  const result = estimateRun({ samples, profile: { method: 'local', hardware: 'cpu/8' }, complexes: proteins([200]) });
  assert.strictEqual(result.available, false);
});

test('jobs beyond the measured sizes make the figure a lower bound', () => {
  const result = estimateRun({ samples: flatSamples(40, 100), profile: {}, complexes: proteins([200, 4000]) });
  assert.strictEqual(result.lowerBound, true);
  assert.strictEqual(result.extrapolatedShare, 0.5);
  assert.strictEqual(result.confidence, 'low');
});

test('sizes that tend to fail are reported', () => {
  const samples = [
    ...Array.from({ length: 10 }, () => sample(300, 100)),
    ...Array.from({ length: 10 }, () => sample(3000, 5000, { outcome: 'oom' })),
    ...Array.from({ length: 10 }, () => sample(3000, 400))
  ];
  const result = estimateRun({ samples, profile: {}, complexes: proteins([3000]) });
  assert.ok(result.failedShare > 0.3 && result.failedShare < 0.7);
});
