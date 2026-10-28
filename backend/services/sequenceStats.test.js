const test = require('node:test');
const assert = require('node:assert');
const { computeStats } = require('./sequenceStats');

const row = (role, name, length, copies = 1) => ({ role, name, length, copies });

test('pulldown: pair count, lengths, median and over-limit match a hand count', () => {
  // pair lengths: 150, 250, 400 | 250, 350, 500
  const rows = [
    row('bait', 'B1', 100), row('bait', 'B2', 200),
    row('candidate', 'C1', 50), row('candidate', 'C2', 150), row('candidate', 'C3', 300)
  ];
  const s = computeStats(rows, { mode: 'pulldown', limitAA: 300 });
  assert.strictEqual(s.baits, 2);
  assert.strictEqual(s.candidates, 3);
  assert.strictEqual(s.pairs, 6);
  assert.deepStrictEqual(s.complexLength, { min: 150, median: 250, max: 500, total: 1900 });
  assert.strictEqual(s.overLimit, 3); // 350, 400, 500
  assert.strictEqual(s.totalAA, 800);
  assert.strictEqual(s.longestProtein, 300);
});

test('a protein that is both bait and candidate is counted once', () => {
  const rows = [row('bait', 'X', 100), row('candidate', 'X', 100), row('candidate', 'Y', 40)];
  const s = computeStats(rows, { mode: 'pulldown' });
  assert.strictEqual(s.uniqueProteins, 2);
  assert.strictEqual(s.totalAA, 140);
  assert.strictEqual(s.pairs, 2);
});

test('pulldown with only baits has no pairs yet', () => {
  const s = computeStats([row('bait', 'B', 100)], { mode: 'pulldown' });
  assert.strictEqual(s.pairs, 0);
  assert.strictEqual(s.complexLength, null);
});

test('all_vs_all: unordered pairs of different proteins', () => {
  // pair lengths: 300, 400, 500
  const rows = [row('all', 'A', 100), row('all', 'B', 200), row('all', 'C', 300)];
  const s = computeStats(rows, { mode: 'all_vs_all', limitAA: 350 });
  assert.strictEqual(s.pairs, 3);
  assert.deepStrictEqual(s.complexLength, { min: 300, median: 400, max: 500, total: 1200 });
  assert.strictEqual(s.overLimit, 2);
});

test('all_vs_all needs two proteins', () => {
  assert.strictEqual(computeStats([row('all', 'A', 100)], { mode: 'all_vs_all' }).pairs, 0);
});

test('homo_oligomer: one complex per protein, length scaled by copies', () => {
  const rows = [row('all', 'A', 100, 2), row('all', 'B', 300)];
  const s = computeStats(rows, { mode: 'homo_oligomer', limitAA: 250 });
  assert.strictEqual(s.pairs, 2);
  assert.deepStrictEqual(s.complexLength, { min: 200, median: 200, max: 300, total: 500 });
  assert.strictEqual(s.overLimit, 1);
});

test('large pulldown is counted without enumerating pairs', () => {
  const rows = [];
  for (let i = 0; i < 20000; i += 1) rows.push(row('candidate', `C${i}`, 100 + (i % 900)));
  for (let i = 0; i < 20000; i += 1) rows.push(row('bait', `B${i}`, 100 + (i % 900)));
  const s = computeStats(rows, { mode: 'pulldown', limitAA: 1500 });
  assert.strictEqual(s.pairs, 400000000);
  assert.ok(s.complexLength.median > s.complexLength.min);
  assert.ok(s.overLimit > 0 && s.overLimit < s.pairs);
});
