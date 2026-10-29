const test = require('node:test');
const assert = require('node:assert');
const { sanitiseSample } = require('./speedRecorder');

const DAY = '2026-10-29';
const good = { stage: 'fold', lenA: 300, lenB: 200, method: 'af3', hardware: 'gpu/1', outcome: 'ok', runSeconds: 900, queueSeconds: 60 };

test('a good fold sample becomes a row with the total length', () => {
  assert.deepStrictEqual(sanitiseSample(good, DAY), {
    stage: 'fold', len_a: 300, len_b: 200, total_len: 500, method: 'af3', hardware: 'gpu/1',
    outcome: 'ok', run_seconds: 900, queue_seconds: 60, sampled_on: DAY
  });
});

test('an msa sample has one length and no queue time needed', () => {
  const row = sanitiseSample({ stage: 'msa', lenA: 400, method: 'local', outcome: 'ok', runSeconds: 120 }, DAY);
  assert.strictEqual(row.total_len, 400);
  assert.strictEqual(row.len_b, null);
  assert.strictEqual(row.queue_seconds, null);
  assert.strictEqual(row.hardware, '');
});

test('names, ids and owners never reach the row, even when passed in', () => {
  const row = sanitiseSample({ ...good, name: 'TP53', accession: 'P04637', sequence: 'MKT', ownerId: 7, jobId: 'abc', projectId: 3 }, DAY);
  assert.deepStrictEqual(Object.keys(row).sort(), [
    'hardware', 'len_a', 'len_b', 'method', 'outcome', 'queue_seconds', 'run_seconds', 'sampled_on', 'stage', 'total_len'
  ]);
  assert.ok(!JSON.stringify(row).includes('TP53'));
});

test('unusable samples are refused', () => {
  const refused = [
    null,
    { ...good, stage: 'other' },
    { ...good, outcome: 'maybe' },
    { ...good, lenA: 0 },
    { ...good, lenA: 1.5 },
    { ...good, lenA: 100001 },
    { ...good, lenB: -3 },
    { ...good, runSeconds: -1 },
    { ...good, runSeconds: 1.5 },
    { ...good, runSeconds: 60 * 60 * 24 * 61 },
    { ...good, queueSeconds: -5 },
    { ...good, method: 'has space' },
    { ...good, method: 'TP53 | name'.repeat(10) },
    { ...good, hardware: 'a'.repeat(101) },
    { stage: 'msa', lenA: 300, lenB: 100, method: 'local', outcome: 'ok', runSeconds: 10 }
  ];
  refused.forEach(sample => assert.strictEqual(sanitiseSample(sample, DAY), null, JSON.stringify(sample)));
});
