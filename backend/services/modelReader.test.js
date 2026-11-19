const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readModel, detectFormat } = require('./modelReader');

// Public Protein Data Bank / AlphaFold DB files, kept as fixtures:
// 1CRN (crambin, 46 residues) as mmCIF and PDB, and AlphaFold DB's model of
// P47529 (an 84-residue acyl carrier protein).
const fixture = name => fs.readFileSync(path.join(__dirname, 'testdata', name), 'utf8');
const CRAMBIN = 'TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN';

test('reads the sequence of a PDB-format file from its SEQRES records', async () => {
  const model = await readModel(fixture('1crn.pdb'));
  assert.equal(model.format, 'pdb');
  assert.equal(model.entryId, '1CRN');
  assert.equal(model.chains.length, 1);
  assert.equal(model.chains[0].id, 'A');
  assert.equal(model.chains[0].sequence, CRAMBIN);
  assert.equal(model.chains[0].observedResidues, 46);
});

test('reads the sequence of an mmCIF file from its entity_poly record', async () => {
  const model = await readModel(fixture('1crn.cif'));
  assert.equal(model.format, 'mmcif');
  assert.equal(model.entryId, '1CRN');
  assert.match(model.title, /HYDROPHOBIC PROTEIN/);
  assert.equal(model.method, 'X-RAY DIFFRACTION');
  assert.ok(model.revisionDate);
  assert.equal(model.chains[0].sequence, CRAMBIN);
});

test('reads an AlphaFold DB model', async () => {
  const model = await readModel(fixture('af-p47529.cif'));
  assert.equal(model.entryId, 'AF-P47529-F1');
  assert.equal(model.chains.length, 1);
  assert.equal(model.chains[0].sequence.length, 84);
  assert.equal(model.chains[0].sequence.slice(0, 10), 'MQTHEILLKI');
});

test('does not leave a window global behind', async () => {
  await readModel(fixture('1crn.cif'));
  assert.equal(typeof window, 'undefined');
});

test('falls back to the atoms when a PDB file has no SEQRES', async () => {
  const atoms = fixture('1crn.pdb').split('\n').filter(line => line.startsWith('ATOM')).join('\n');
  const model = await readModel(atoms);
  assert.equal(model.chains[0].sequence, CRAMBIN);
});

test('rejects text that is not a model', async () => {
  await assert.rejects(() => readModel('hello world'), /Not an mmCIF or PDB file/);
  await assert.rejects(() => readModel(''), /empty/);
});

test('rejects a model that has no protein chain', async () => {
  const dna = 'HEADER    DNA\nSEQRES   1 A    4   DA  DC  DG  DT\nATOM      1  C1\' DA A   1       0.0   0.0   0.0  1.00  0.00           C\n';
  await assert.rejects(() => readModel(dna), /No protein chain/);
});

test('recognises the format by content', () => {
  assert.equal(detectFormat('data_1ABC\n#\n_entry.id 1ABC\n'), 'mmcif');
  assert.equal(detectFormat('HEADER    X\nATOM'), 'pdb');
  assert.equal(detectFormat('>sp|P1|X\nMKT'), null);
});
