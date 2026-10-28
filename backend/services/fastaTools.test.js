const test = require('node:test');
const assert = require('node:assert');
const {
  sanitizeName, parseFasta, buildEntry, uniqueNames, formatFasta, formatList, validateSequence
} = require('./fastaTools');

const SEQ = 'MQGSVTEFLKPRLVDIEQVSSTHAKVTLEP';

test('sanitizeName keeps file-safe characters only', () => {
  assert.strictEqual(sanitizeName('sp|P0A7Z4|RPOA'), 'sp_P0A7Z4_RPOA');
  assert.strictEqual(sanitizeName('a b;c#d:e'), 'a_b_c_d_e');
  assert.strictEqual(sanitizeName('  --x--  '), 'x');
  assert.strictEqual(sanitizeName(''), '');
  assert.strictEqual(sanitizeName('a'.repeat(300)).length, 100);
});

test('parseFasta joins lines, upper-cases, drops whitespace and trailing *', () => {
  const records = parseFasta(`>one desc\r\nmqgs vtef\r\nLK*\r\n\r\n>two\r\nAAAA\r\n`);
  assert.deepStrictEqual(records, [
    { header: 'one desc', sequence: 'MQGSVTEFLK' },
    { header: 'two', sequence: 'AAAA' }
  ]);
});

test('parseFasta treats header-less text as one record', () => {
  assert.deepStrictEqual(parseFasta('MQGSVTEFLK\nPRLV'), [{ header: '', sequence: 'MQGSVTEFLKPRLV' }]);
  assert.deepStrictEqual(parseFasta(''), []);
});

test('UniProt header becomes accession + protein name without OS=...', () => {
  const entry = buildEntry({
    header: 'sp|P0A7Z4|RPOA_ECOLI DNA-directed RNA polymerase subunit alpha OS=Escherichia coli (strain K12) OX=83333 GN=rpoA PE=1 SV=1',
    sequence: SEQ
  }, 'x');
  assert.strictEqual(entry.name, 'P0A7Z4');
  assert.strictEqual(entry.description, 'DNA-directed RNA polymerase subunit alpha');
  assert.strictEqual(entry.length, 30);
  assert.deepStrictEqual(entry.errors, []);
});

test('plain header: first word is the name, the rest the description', () => {
  const entry = buildEntry({ header: 'my_protein some words', sequence: SEQ }, 'x');
  assert.strictEqual(entry.name, 'my_protein');
  assert.strictEqual(entry.description, 'some words');
});

test('empty header falls back to the given name', () => {
  assert.strictEqual(buildEntry({ header: '', sequence: SEQ }, 'sequence_3').name, 'sequence_3');
});

test('validation reports bad characters and bad lengths', () => {
  assert.ok(validateSequence('MQGSVTEFLKB')[0].includes('B'));
  assert.ok(validateSequence('MQG').some(e => e.includes('shorter')));
  assert.ok(validateSequence('A'.repeat(20001)).some(e => e.includes('longer')));
  assert.deepStrictEqual(validateSequence(SEQ), []);
  assert.deepStrictEqual(validateSequence(''), ['empty sequence']);
});

test('uniqueNames numbers repeats', () => {
  const out = uniqueNames([{ name: 'A' }, { name: 'B' }, { name: 'A' }, { name: 'A' }]);
  assert.deepStrictEqual(out.map(e => e.name), ['A', 'B', 'A_2', 'A_3']);
});

test('FASTA output uses bare names and wraps at 60', () => {
  const fasta = formatFasta([{ name: 'P1', sequence: 'A'.repeat(130) }]);
  assert.strictEqual(fasta, `>P1\n${'A'.repeat(60)}\n${'A'.repeat(60)}\n${'A'.repeat(10)}\n`);
});

test('list output: one per line, copies as name:N', () => {
  assert.strictEqual(formatList([{ name: 'P1', copies: 1 }, { name: 'P2', copies: 2 }]), 'P1\nP2:2\n');
});
