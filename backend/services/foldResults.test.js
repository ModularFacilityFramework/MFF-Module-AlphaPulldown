const test = require('node:test');
const assert = require('node:assert');
const results = require('./foldResults');

// What AlphaFold 3 writes for a two-chain complex (trimmed to the fields read).
const SUMMARY = {
  chain_iptm: [0.71, 0.69],
  chain_pair_iptm: [[0.9, 0.7], [0.7, 0.88]],
  chain_pair_pae_min: [[0.8, 4.5], [3.2, 0.75]],
  chain_ptm: [0.92, 0.85],
  fraction_disordered: 0.12,
  has_clash: 0.0,
  iptm: 0.7,
  ptm: 0.81,
  ranking_score: 0.83
};

test('scores come out of a two-chain summary, the interface PAE from the off-diagonal', () => {
  assert.deepStrictEqual(results.scoresFromSummary(SUMMARY), {
    iptm: 0.7, ptm: 0.81, rankingScore: 0.83, interfacePaeMin: 3.2, hasClash: 0, fractionDisordered: 0.12, chains: 2
  });
  assert.strictEqual(results.scoresFromSummary({ ...SUMMARY, has_clash: 1.0 }).hasClash, 1);
});

test('a single chain has no iptm and no interface', () => {
  const mono = results.scoresFromSummary({ chain_ptm: [0.9], chain_pair_pae_min: [[0.7]], iptm: 0, ptm: 0.9, ranking_score: 0.8, has_clash: false });
  assert.deepStrictEqual([mono.iptm, mono.interfacePaeMin, mono.ptm, mono.chains], [null, null, 0.9, 1]);
});

test('malformed or missing fields give nulls, never NaN or a crash', () => {
  assert.strictEqual(results.scoresFromSummary(null), null);
  assert.strictEqual(results.scoresFromSummary('x'), null);
  const odd = results.scoresFromSummary({ chain_ptm: [1, 1], iptm: 'high', ptm: NaN, chain_pair_pae_min: [[1, 2], [3]] });
  assert.deepStrictEqual([odd.iptm, odd.ptm, odd.rankingScore, odd.interfacePaeMin, odd.hasClash], [null, null, null, null, null]);
  assert.strictEqual(results.offDiagonalMin([[1, null], [null, 1]]), null);
  assert.strictEqual(results.offDiagonalMin([[1, 5, 2], [7, 1, 9], [4, 8, 1]]), 2);
});

test('the best model and summary are the top-level files of a fold folder', () => {
  const names = ['TERMS_OF_USE.md', 'a_and_b_confidences.json', 'a_and_b_data.json', 'a_and_b_model.cif',
    'a_and_b_ranking_scores.csv', 'a_and_b_summary_confidences.json', 'seed-1_sample-0'];
  assert.deepStrictEqual(results.pickFiles(names), { summary: 'a_and_b_summary_confidences.json', model: 'a_and_b_model.cif' });
  assert.deepStrictEqual(results.pickFiles(['slurm.out']), { summary: null, model: null });
});
