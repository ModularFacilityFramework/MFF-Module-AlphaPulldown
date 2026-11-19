const test = require('node:test');
const assert = require('node:assert');
const { levelFor, summariseSamples, describeLabels, lastDays, MAX_GROUPS } = require('./speedSummary');

const row = (totalLen, runSeconds, extra = {}) => ({
  stage: 'fold', method: 's1-msadefault', hardware: 'gpu1', totalLen, runSeconds, queueSeconds: null, outcome: 'ok', ...extra
});

test('confidence uses the same thresholds as the estimator', () => {
  assert.deepStrictEqual([0, 4, 5, 29, 30].map(levelFor), ['none', 'none', 'low', 'low', 'good']);
});

test('samples are grouped by stage, method and hardware, msa first, best measured first', () => {
  const rows = [
    row(300, 10), row(300, 10), row(300, 10),
    row(300, 10, { hardware: 'gpu2' }),
    row(120, 5, { stage: 'msa', method: 'local', hardware: 'default/8cpu' })
  ];
  const { groups, groupsOmitted } = summariseSamples(rows);
  assert.deepStrictEqual(groups.map(g => [g.stage, g.hardware, g.samples]), [['msa', 'default/8cpu', 1], ['fold', 'gpu1', 3], ['fold', 'gpu2', 1]]);
  assert.strictEqual(groupsOmitted, 0);
});

test('a group counts outcomes, spreads only the finished runs, and reads queue time', () => {
  const rows = [
    ...[100, 200, 300, 400, 500].map((s, i) => row(200 + i, s, { queueSeconds: 10 * (i + 1) })),
    row(900, 7, { outcome: 'oom' }),
    row(900, 7, { outcome: 'timeout' }),
    row(900, 7, { outcome: 'failed' })
  ];
  const [g] = summariseSamples(rows).groups;
  assert.deepStrictEqual([g.samples, g.finished, g.oom, g.timeout, g.failed, g.level], [8, 5, 1, 1, 1, 'low']);
  assert.deepStrictEqual(g.run, { p25: 200, p50: 300, p90: 460 });
  assert.deepStrictEqual(g.queue, { p25: 20, p50: 30, p90: 46 });
  assert.deepStrictEqual([g.minLength, g.maxLength], [200, 900]);
});

test('a group with nothing finished has no run spread and no estimate level', () => {
  const [g] = summariseSamples([row(300, 5, { outcome: 'oom' })]).groups;
  assert.deepStrictEqual([g.run, g.queue, g.level, g.finished], [null, null, 'none', 0]);
});

test('size bands hold every sample once and drop empty bands', () => {
  const rows = [100, 250, 251, 600, 5000, 5001, 9000].map(len => row(len, 10));
  const [g] = summariseSamples(rows).groups;
  assert.deepStrictEqual(g.bands.map(b => [b.label, b.samples]), [
    ['up to 250', 2], ['251 - 500', 1], ['501 - 1000', 1], ['3001 - 5000', 1], ['over 5000', 2]
  ]);
  assert.strictEqual(g.bands.reduce((acc, b) => acc + b.samples, 0), rows.length);
});

test('a band with only failures shows its count but no timing', () => {
  const [g] = summariseSamples([row(100, 5), row(700, 7, { outcome: 'oom' })]).groups;
  assert.deepStrictEqual(g.bands.map(b => [b.label, b.finished, b.run === null]), [['up to 250', 1, false], ['501 - 1000', 0, true]]);
});

test('the list of groups is capped and the rest counted', () => {
  const rows = Array.from({ length: MAX_GROUPS + 3 }, (_, i) => row(100, 1, { hardware: `gpu${i}` }));
  const { groups, groupsOmitted } = summariseSamples(rows);
  assert.deepStrictEqual([groups.length, groupsOmitted], [MAX_GROUPS, 3]);
});

test('labels read in words, and an unknown label is shown as it is', () => {
  assert.deepStrictEqual(describeLabels('fold', 's3-mmseqs2-tpl-reuse', 'gpu2'), {
    methodText: '3 seeds, MMseqs2 server, templates, MSAs from the MSA tab', hardwareText: '2 GPUs'
  });
  assert.deepStrictEqual(describeLabels('fold', 's1-localdb', 'gpu1'), {
    methodText: '1 seed, local database, no templates', hardwareText: '1 GPU'
  });
  assert.deepStrictEqual(describeLabels('msa', 'mmseqs2', 'cpu_a+cpu_b/8cpu'), {
    methodText: 'MMseqs2 server search', hardwareText: '8 CPUs, partition cpu_a or cpu_b'
  });
  assert.strictEqual(describeLabels('msa', 'local', 'default/4cpu').hardwareText, '4 CPUs, default partition');
  assert.deepStrictEqual(describeLabels('fold', 'af3', ''), { methodText: 'af3', hardwareText: 'not recorded' });
});

test('the activity series fills quiet days with zero and ignores days outside it', () => {
  const series = lastDays([
    { day: '2026-10-29', stage: 'msa', n: 4 },
    { day: '2026-10-31', stage: 'fold', n: 2 },
    { day: '2026-10-31', stage: 'msa', n: 1 },
    { day: '2026-09-01', stage: 'fold', n: 99 }
  ], '2026-10-31', 4);
  assert.deepStrictEqual(series, [
    { day: '2026-10-28', msa: 0, fold: 0 },
    { day: '2026-10-29', msa: 4, fold: 0 },
    { day: '2026-10-30', msa: 0, fold: 0 },
    { day: '2026-10-31', msa: 1, fold: 2 }
  ]);
});
