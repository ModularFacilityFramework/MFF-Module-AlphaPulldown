const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./targetRules');

const A = 'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQFEVV';
const B = 'MSTNPKPQRKTKRNTNRRPQDVKFPGGGQIVGGVYLLPRRGPRLGVRATRKTSERSQPRGRRQPIPKARRPEG';
const GENOME = { upid: 'UP000000807', organism: 'Mycoplasmoides genitalium', taxId: 243273 };

test('normalizeChains cleans the sequence and names the chains', () => {
  const { chains, errors } = rules.normalizeChains([
    { origin: 'uniprot', accession: 'p47529', sequence: ` ${A.slice(0, 30)}\n${A.slice(30)} `, copies: '2' },
    { origin: 'sequence', sequence: `>my protein\n${B}`, label: 'my protein!' }
  ]);
  assert.deepEqual(errors, []);
  assert.equal(chains[0].accession, 'P47529');
  assert.equal(chains[0].sequence, A);
  assert.equal(chains[0].copies, 2);
  assert.equal(chains[0].label, 'P47529');
  assert.equal(chains[1].sequence, B);
  assert.equal(chains[1].label, 'my_protein');
  assert.equal(chains[1].accession, null);
});

test('normalizeChains makes chain labels unique', () => {
  const { chains } = rules.normalizeChains([{ sequence: A, label: 'x' }, { sequence: B, label: 'x' }]);
  assert.deepEqual(chains.map(c => c.label), ['x', 'x_2']);
});

test('normalizeChains reports what is wrong, chain by chain', () => {
  const { errors } = rules.normalizeChains([
    { origin: 'uniprot', accession: 'nope', sequence: A },
    { sequence: 'MK1' },
    { sequence: A, copies: 99 }
  ]);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /Chain 1.*not a UniProt accession/);
  assert.match(errors.join(' '), /Chain 2/);
  assert.match(errors.join(' '), /Chain 3: copies/);
  assert.deepEqual(rules.normalizeChains([]).errors, ['Add at least one chain.']);
});

test('describeEdit says what was removed from the UniProt sequence', () => {
  assert.deepEqual(rules.describeEdit(null, A), { edited: false, kind: 'own', summary: '' });
  assert.deepEqual(rules.describeEdit(A, A), { edited: false, kind: 'none', summary: '' });
  const trimmed = rules.describeEdit(A, A.slice(20));
  assert.equal(trimmed.kind, 'trimmed');
  assert.match(trimmed.summary, /20 residues removed from the start \(1-20\)/);
  const both = rules.describeEdit(A, A.slice(5, 60));
  assert.match(both.summary, /5 residues removed from the start.*and 10 residues removed from the end/);
  assert.equal(rules.describeEdit(A, `HHHHHH${A}`).kind, 'extended');
  const changed = rules.describeEdit(A, `${A.slice(0, 30)}W${A.slice(31)}`);
  assert.equal(changed.kind, 'modified');
  assert.match(changed.summary, /1 difference/);
});

const uniprotChain = (extra = {}) => ({
  origin: 'uniprot', accession: 'P47529', label: 'ACP', sequence: A, copies: 1,
  uniprot: { organism: 'Mycoplasmoides genitalium', taxId: 243273, proteomes: [{ upid: 'UP000000807' }] },
  ...extra
});

test('a UniProt chain is matched when UniProt lists it in the genome', () => {
  const result = rules.checkChain(uniprotChain(), GENOME, null);
  assert.equal(result.status, 'matched');
  assert.equal(result.basis, 'uniprot_proteome');
});

test('a UniProt chain falls back to the taxon, and is not matched for another organism', () => {
  const other = uniprotChain({ uniprot: { organism: 'Homo sapiens', taxId: 9606, proteomes: [{ upid: 'UP000005640' }] } });
  assert.equal(rules.checkChain(other, GENOME, null).status, 'not_matched');
  const sameTaxon = uniprotChain({ uniprot: { organism: 'M. genitalium', taxId: 243273, proteomes: [] } });
  assert.equal(rules.checkChain(sameTaxon, GENOME, null).basis, 'taxon');
});

test('a chain cannot be checked without a genome', () => {
  assert.equal(rules.checkChain(uniprotChain(), null, null).status, 'not_checked');
});

const library = [
  { accession: 'P47529', entry: 'ACPH_MYCGE', gene: 'acpP', description: 'Acyl carrier protein', sequence: A },
  { accession: 'P00001', entry: 'OTHER_MYCGE', gene: '', description: 'Other', sequence: B }
];

test('an own sequence is matched against the library proteome', () => {
  const own = { origin: 'sequence', accession: null, label: 'mine', sequence: A.slice(10, 50), copies: 1 };
  const result = rules.checkChain(own, GENOME, library);
  assert.equal(result.status, 'matched');
  assert.equal(result.basis, 'library_contained');
  assert.equal(result.match.accession, 'P47529');
  assert.equal(result.match.referenceStart, 11);
});

test('an own sequence that is in no protein of the genome is not matched', () => {
  const own = { origin: 'sequence', label: 'mine', sequence: 'GGGGSGGGGSGGGGSPPPPPPPPPPWWWWWWWWWWDDDDDDDD', copies: 1 };
  assert.equal(rules.checkChain(own, GENOME, library).status, 'not_matched');
});

test('an own sequence cannot be checked when the proteome is not in the library', () => {
  const own = { origin: 'sequence', label: 'mine', sequence: A, copies: 1 };
  const result = rules.checkChain(own, GENOME, null);
  assert.equal(result.status, 'not_checked');
  assert.equal(result.basis, 'library_missing');
});

const withStatus = (chain, status) => ({ ...chain, validation: { status } });

test('a single chain or a homo-oligomer is never chimeric', () => {
  const one = [withStatus({ label: 'a', sequence: A }, 'not_matched')];
  assert.equal(rules.assessChimera(one).flagged, false);
  const two = [withStatus({ label: 'a', sequence: A }, 'not_matched'), withStatus({ label: 'b', sequence: A }, 'not_matched')];
  assert.equal(rules.assessChimera(two).heteromer, false);
  assert.equal(rules.assessChimera(two).flagged, false);
});

test('a heteromer with an unconfirmed chain is chimeric, and names that chain', () => {
  const chains = [withStatus({ label: 'a', sequence: A }, 'matched'), withStatus({ label: 'b', sequence: B }, 'not_checked')];
  const result = rules.assessChimera(chains);
  assert.equal(result.flagged, true);
  assert.deepEqual(result.chains, ['b']);
  assert.match(result.warning, /huge grain of salt/);
  chains[1].validation.status = 'matched';
  assert.equal(rules.assessChimera(chains).flagged, false);
});

test('confirmProblems asks for a chain and a genome', () => {
  assert.deepEqual(rules.confirmProblems({ chains: [], genome: null }), ['Add at least one chain.']);
  assert.equal(rules.confirmProblems({ chains: [{}], genome: null }).length, 1);
  assert.deepEqual(rules.confirmProblems({ chains: [{}], genome: GENOME }), []);
  assert.equal(rules.confirmProblems({ chains: [{}], genome: GENOME, model: { state: 'selected' } }).length, 1);
  assert.deepEqual(rules.confirmProblems({ chains: [{}], genome: GENOME, model: { state: 'accepted' } }), []);
});

test('mapModelToChains picks the best model chain per target chain', () => {
  const model = [{ id: 'A', sequence: B }, { id: 'B', sequence: `GS${A}` }];
  const mapping = rules.mapModelToChains([{ label: 'one', sequence: A }, { label: 'two', sequence: 'GGGGSGGGGSGGGGSPPPPPPPPPPWWWWWWWWWW' }], model);
  assert.equal(mapping[0].modelChain, 'B');
  assert.equal(mapping[0].status, 'contained');
  assert.equal(mapping[1].modelChain, null);
  assert.equal(mapping[1].status, 'none');
  assert.equal(rules.modelCovers(mapping), false);
  assert.equal(rules.modelCovers([mapping[0]]), true);
});

test('methodsText records sources, edits, genome, acknowledgement and model', () => {
  const target = {
    confirmedAt: new Date('2026-11-19T10:00:00Z'),
    chains: [
      { ...uniprotChain(), length: 71, edited: true, editSummary: '20 residues removed from the start (1-20) of the UniProt sequence', validation: { status: 'matched' } },
      { origin: 'sequence', label: 'mine', length: 70, copies: 2, validation: { status: 'not_checked' } }
    ],
    genome: { ...GENOME, proteomeType: 'Reference and representative proteome', genomeAssembly: { id: 'GCA_000027325.1' } },
    chimera: { acknowledged: { at: new Date('2026-11-19T09:00:00Z'), chains: ['mine'] } },
    model: { source: 'pdb', modelId: '1CRN', version: '2020-05-27', fetchedAt: new Date('2026-11-19T08:00:00Z'), state: 'accepted' }
  };
  const text = rules.methodsText(target);
  assert.match(text, /2 chains \(3 copies in the complex\)/);
  assert.match(text, /UniProt entry P47529 from Mycoplasmoides genitalium/);
  assert.match(text, /20 residues removed from the start/);
  assert.match(text, /sequence supplied by the user/);
  assert.match(text, /UP000000807.*GCA_000027325.1/);
  assert.match(text, /acknowledged this warning on 2026-11-19/);
  assert.match(text, /PDB entry 1CRN, version 2020-05-27, obtained on 2026-11-19/);
  assert.match(text, /not used for structure prediction/);
  assert.match(text, /confirmed on 2026-11-19/);
  assert.equal(rules.methodsText({ chains: [] }), '');
});
