const test = require('node:test');
const assert = require('node:assert/strict');
const { compareSequences, findBestMatches } = require('./sequenceMatch');

const PROTEIN = 'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQFEVV';

test('the same sequence is exact', () => {
  const result = compareSequences(PROTEIN, PROTEIN);
  assert.equal(result.status, 'exact');
  assert.equal(result.identity, 1);
});

test('a stretch of the reference is contained, with its position', () => {
  const result = compareSequences(PROTEIN.slice(10, 40), PROTEIN);
  assert.equal(result.status, 'contained');
  assert.equal(result.referenceStart, 11);
  assert.equal(result.referenceEnd, 40);
  assert.ok(result.referenceCoverage < 1);
});

test('a tag added to the reference is extended', () => {
  const result = compareSequences(`MGSSHHHHHH${PROTEIN}`, PROTEIN);
  assert.equal(result.status, 'extended');
  assert.equal(result.queryStart, 11);
});

test('a point mutant is similar, with one difference', () => {
  const mutant = `${PROTEIN.slice(0, 30)}W${PROTEIN.slice(31)}`;
  const result = compareSequences(mutant, PROTEIN);
  assert.equal(result.status, 'similar');
  assert.equal(result.differences, 1);
  assert.ok(result.identity > 0.97);
});

test('an unrelated sequence is different', () => {
  const unrelated = 'GGGGSGGGGSGGGGSPPPPPPPPPPWWWWWWWWWWDDDDDDDD';
  assert.equal(compareSequences(unrelated, PROTEIN).status, 'different');
});

test('empty input is different, not an error', () => {
  assert.equal(compareSequences('', PROTEIN).status, 'different');
  assert.equal(compareSequences(PROTEIN, '').status, 'different');
});

test('findBestMatches finds an exact record first', () => {
  const records = [
    { accession: 'A1', sequence: 'MSTNPKPQRKTKRNTNRRPQDVKFPGG' },
    { accession: 'B2', sequence: PROTEIN },
    { accession: 'C3', sequence: `XX${PROTEIN}YY` }
  ];
  const matches = findBestMatches(PROTEIN, records);
  assert.equal(matches[0].record.accession, 'B2');
  assert.equal(matches[0].comparison.status, 'exact');
  assert.equal(matches[1].record.accession, 'C3');
  assert.equal(matches[1].comparison.status, 'contained');
});

test('findBestMatches aligns when nothing matches directly', () => {
  const mutant = `${PROTEIN.slice(0, 30)}W${PROTEIN.slice(31)}`;
  const records = [
    { accession: 'A1', sequence: 'MSTNPKPQRKTKRNTNRRPQDVKFPGGGQIVGGVYLLPRRGPRLGVRATRKTSERSQPRGRRQPIPKARRPEGRTWAQPGYPWPLYGNEGCGWAGWLLSPRGSRPSWGPTDPRRRSRNLGKVIDTLTCGFADLMGYIPLVGAPLGGVARALAHGVRVLEDGVNYATGNLPGCSFSIFLLALLSCLTVPASA' },
    { accession: 'B2', sequence: PROTEIN },
    { accession: 'C3', sequence: 'MAHHHHHHVDDDDKMENFQKVEKIGEGTYGVVYKARNKLTGEVVALKKIRLDTETEGVPSTAIREISLLKELNHPNIVKLLDVIHTENKLYLVFEFLHQDLKKFMDASALTGIPLPLIKSYLFQLLQGLAFCHSHRVLHRDLKPQNLLINTEGAIKLADFGLARAFGVPVRTYTHEVVTLWYRAPEILLGCKYYSTAVDIWSLGCIFAEMVTRRALFPGDSEIDQLFRIFRTLGTPDEVVWPGVTSMPDYKPSFPKWARQDFSKVVPPLDEDGRSLLSQMLHYDPNKRISAKAALAHPFFQDVTKPVPHLRL' }
  ];
  const matches = findBestMatches(mutant, records);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.accession, 'B2');
  assert.equal(matches[0].comparison.status, 'similar');
});

test('findBestMatches returns nothing for an unrelated query', () => {
  const records = [{ accession: 'B2', sequence: PROTEIN }];
  assert.deepEqual(findBestMatches('GGGGSGGGGSGGGGSPPPPPPPPPPWWWWWWWWWWDDDDDDDD', records), []);
});
