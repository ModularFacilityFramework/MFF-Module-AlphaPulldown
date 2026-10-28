const test = require('node:test');
const assert = require('node:assert');
const { parseUniprotFasta, filterEntries, summarize } = require('./proteomeIndex');

const FASTA = `>sp|P0A7Z4|RPOA_ECOLI DNA-directed RNA polymerase subunit alpha OS=Escherichia coli (strain K12) OX=83333 GN=rpoA PE=1 SV=1
MQGSVTEFLKPRLVDIEQVSSTHAKVTLEP
IDGVLHEYSTKEGVQEDILEILLNLKGLAV
>tr|A0A0A0|A0A0A0_ECOLI Uncharacterized protein OS=Escherichia coli OX=562 PE=4 SV=1
MKKKKKKKKKKKKKKK
>not-uniprot header
MKKKKKKKKKKKKKKK
`;

test('parses accession, entry, gene, description, organism, reviewed, length', () => {
  const entries = parseUniprotFasta(FASTA);
  assert.strictEqual(entries.length, 2); // the non-UniProt header is skipped
  assert.deepStrictEqual(summarize(entries[0]), {
    accession: 'P0A7Z4',
    entry: 'RPOA_ECOLI',
    gene: 'rpoA',
    description: 'DNA-directed RNA polymerase subunit alpha',
    organism: 'Escherichia coli (strain K12)',
    reviewed: true,
    length: 60
  });
  assert.strictEqual(entries[1].gene, '');
  assert.strictEqual(entries[1].reviewed, false);
});

test('filter matches every word, case-insensitively, across fields', () => {
  const entries = parseUniprotFasta(FASTA);
  assert.strictEqual(filterEntries(entries, { q: 'POLYMERASE alpha' }).length, 1);
  assert.strictEqual(filterEntries(entries, { q: 'rpoa' }).length, 1);
  assert.strictEqual(filterEntries(entries, { q: 'polymerase uncharacterized' }).length, 0);
  assert.strictEqual(filterEntries(entries, {}).length, 2);
});

test('filter bounds length inclusively', () => {
  const entries = parseUniprotFasta(FASTA);
  assert.strictEqual(filterEntries(entries, { minLen: 60 }).length, 1);
  assert.strictEqual(filterEntries(entries, { maxLen: 16 }).length, 1);
  assert.strictEqual(filterEntries(entries, { minLen: 17, maxLen: 59 }).length, 0);
});

test('summaries carry no sequence text', () => {
  assert.strictEqual('sequence' in summarize(parseUniprotFasta(FASTA)[0]), false);
});
