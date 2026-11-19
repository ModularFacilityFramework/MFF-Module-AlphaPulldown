const test = require('node:test');
const assert = require('node:assert');
const prov = require('./provenance');

const PROTEOME = {
  id: 3, upid: 'UP000000807', organism: 'Mycoplasma genitalium (strain ATCC 33530 / G37)', tax_id: 243273, proteome_type: 'Reference proteome',
  release_name: '2026_04', release_date: '04-November-2026', subset: 'reviewed', entries: 485, sha256: 'ab12cd34ef56ab12cd34ef56', source: 'UniProt REST API'
};
const SET = { id: 9, set_key: 'UP000000807_2026_04_reviewed_v1_12345678', tag: 'v1', format: 'af3_json', max_template_date: '2050-01-01' };
const MODULE = { id: 'alphapulldown', version: '1.2.3' };
const SETTINGS = { env_name: 'alphafold3_alphapulldown', data_dir: '/db', pdb_seqres_path: '/db/pdb_seqres/pdb_seqres.txt', max_template_date: '2050-01-01' };
const ENVIRONMENT = {
  software: { alphapulldown: '2.9.0', alphafold3: '3.0.4', jax: '0.10.2' },
  databases: [
    { name: 'uniref90_2022_05.fa', bytes: 1, modified: '2025-05-08' },
    { name: 'mgy_clusters_2022_05.fa', bytes: 1, modified: '2025-05-08' },
    { name: 'uniprot_all_2021_04.fa', bytes: 1, modified: '2025-05-08' },
    { name: 'bfd-first_non_consensus_sequences.fasta', bytes: 1, modified: '2025-05-08' },
    { name: 'pdb_2022_09_28_mmcif_files.tar', bytes: 1, modified: '2024-11-18' },
    { name: 'pdb_seqres.txt', bytes: 1, modified: '2026-07-25', role: 'pdb_seqres' },
    { name: 'mmcif_files', bytes: null, modified: '2024-03-21', role: 'templates' }
  ]
};

test('database files are named and versioned from their file names', () => {
  const described = prov.describeDatabases(ENVIRONMENT.databases);
  assert.deepStrictEqual(described.slice(0, 3).map(d => [d.label, d.version]), [['UniRef90', '2022_05'], ['MGnify', '2022_05'], ['UniProt', '2021_04']]);
  assert.strictEqual(described[4].version, '2022-09-28');
  assert.strictEqual(described[5].label, 'PDB seqres');
  assert.strictEqual(prov.describeDatabases([{ name: 'odd.fa', modified: '2025-01-01' }])[0].label, 'odd.fa');
  assert.deepStrictEqual(prov.describeDatabases(undefined), []);
});

test('a feature run record freezes the proteome version, the feature set and the settings', () => {
  const record = prov.featureRunRecord({
    module: MODULE, settings: SETTINGS, redo: false, groups: [{ proteome: PROTEOME, set: SET, count: 40 }], localProteins: 2, total: 42, createdAt: '2026-11-19T10:00:00Z'
  });
  assert.strictEqual(record.kind, 'features');
  assert.deepStrictEqual(record.proteins, { total: 42, fromLibrary: 40, local: 2 });
  assert.strictEqual(record.proteomes[0].upid, 'UP000000807');
  assert.strictEqual(record.proteomes[0].release, '2026_04');
  assert.strictEqual(record.proteomes[0].sha256, PROTEOME.sha256);
  assert.deepStrictEqual(record.proteomes[0].featureSet, { id: 9, key: SET.set_key, tag: 'v1', format: 'af3_json', maxTemplateDate: '2050-01-01' });
  assert.strictEqual(record.settings.maxTemplateDate, '2050-01-01');
  assert.strictEqual(record.environment, null, 'what the job observed is added when it ends');
});

test('the environment a job observed is added without touching the planned facts', () => {
  const record = prov.featureRunRecord({ module: MODULE, settings: SETTINGS, redo: false, groups: [], localProteins: 1, total: 1, createdAt: 'x' });
  const merged = prov.withEnvironment(record, ENVIRONMENT);
  assert.strictEqual(merged.environment.software.alphapulldown, '2.9.0');
  assert.strictEqual(merged.settings.environment, 'alphafold3_alphapulldown');
  assert.strictEqual(prov.withEnvironment(record, null), record);
});

test('the methods text names the proteome, the databases, the software and the citation', () => {
  const feature = prov.withEnvironment(prov.featureRunRecord({
    module: MODULE, settings: SETTINGS, redo: false, groups: [{ proteome: PROTEOME, set: SET, count: 40 }], localProteins: 0, total: 40, createdAt: 'x'
  }), ENVIRONMENT);
  const cofold = prov.cofoldRunRecord({
    module: MODULE, mode: 'pulldown', options: { seeds: 3, gpuCount: 1, mmseqs2: 'default', templates: false }, groups: [{ proteome: PROTEOME, set: SET, count: 40 }], localProteins: 0, pairs: 120, createdAt: 'x'
  });
  const { text, missing } = prov.methodsText({ feature, cofold });
  assert.deepStrictEqual(missing, []);
  [
    'UP000000807', 'UniProt release 2026_04 of 04-November-2026', 'reviewed (Swiss-Prot) entries only', '485 sequences', 'taxon 243273',
    'AlphaPulldown 2.9.0', 'AlphaFold 3 3.0.4', 'UniRef90 2022_05', 'MGnify 2022_05', 'UniProt 2021_04', 'maximum template date of 2050-01-01',
    SET.set_key, '120 in this run', '3 model seeds', 'templates off', 'doi:10.1093/bioinformatics/btaf115'
  ].forEach(part => assert.ok(text.includes(part), `missing: ${part}\n${text}`));
});

test('what was not recorded is reported, never guessed', () => {
  const feature = prov.featureRunRecord({ module: MODULE, settings: SETTINGS, redo: false, groups: [{ proteome: PROTEOME, set: SET, count: 1 }], localProteins: 0, total: 1, createdAt: 'x' });
  const { text, missing } = prov.methodsText({ feature, cofold: null });
  assert.strictEqual(missing.length, 2);
  assert.ok(missing[0].includes('not ended'));
  assert.ok(!text.includes('predicted'), 'no prediction sentence without a prediction run');
  assert.ok(!/AlphaPulldown \d/.test(text), 'no version without an observed environment');
  assert.strictEqual(prov.methodsText({ feature: null, cofold: null }).text.includes('cite'), true);
});

test('the capture script refuses a wrong environment and checks feature sets under a lock', () => {
  assert.match(prov.CAPTURE_SCRIPT, /sys\.exit\(5\)/);
  assert.match(prov.CAPTURE_SCRIPT, /fcntl\.flock\(lock, fcntl\.LOCK_EX\)/);
  assert.match(prov.CAPTURE_SCRIPT, /sys\.exit\(3\)/);
  assert.match(prov.CAPTURE_SCRIPT, /os\.replace\(tmp, set_file\)/);
});
