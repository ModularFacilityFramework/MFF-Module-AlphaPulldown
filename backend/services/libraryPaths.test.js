const test = require('node:test');
const assert = require('node:assert');
const paths = require('./libraryPaths');

const CONFIG = { format: 'af3_json', maxTemplateDate: '2050-01-01', dataDir: '/data/db' };

test('a library directory is an absolute plain path without dot segments', () => {
  assert.ok(paths.isValidLibraryDir('/home/linuxhomes/software/alphapulldown_library'));
  ['', 'relative/path', '/a/../b', '/a/./b', '/a b', '/a;rm', '/', null, undefined, 5].forEach(bad => assert.ok(!paths.isValidLibraryDir(bad), String(bad)));
});

test('a proteome version has one folder per UniProt id, release and subset', () => {
  assert.strictEqual(
    paths.proteomeDir('/lib', { upid: 'UP000001584', release: '2025_03', subset: 'all' }),
    '/lib/proteomes/UP000001584/2025_03/all'
  );
  assert.throws(() => paths.proteomeDir('/lib', { upid: 'UP1', release: '2025_03', subset: 'all' }));
  assert.throws(() => paths.proteomeDir('/lib', { upid: 'UP000001584', release: '../x', subset: 'all' }));
  assert.throws(() => paths.proteomeDir('/lib', { upid: 'UP000001584', release: '2025_03', subset: 'other' }));
});

test('the feature set key names the proteome version, the tag and the configuration', () => {
  const key = paths.featureSetKey({ upid: 'UP000001584', release: '2025_03', subset: 'reviewed', tag: '2026a', ...CONFIG });
  assert.match(key, /^UP000001584_2025_03_reviewed_2026a_[0-9a-f]{8}$/);
  assert.strictEqual(paths.featureSetDir('/lib', key), `/lib/features/${key}`);
});

test('a different template date, database folder or format is a different feature set', () => {
  const base = paths.configHash(CONFIG);
  assert.strictEqual(paths.configHash({ ...CONFIG }), base);
  assert.notStrictEqual(paths.configHash({ ...CONFIG, maxTemplateDate: '2023-01-01' }), base);
  assert.notStrictEqual(paths.configHash({ ...CONFIG, dataDir: '/other' }), base);
  assert.notStrictEqual(paths.configHash({ ...CONFIG, format: 'pkl' }), base);
});

test('keys and tags that could escape the library are refused', () => {
  assert.throws(() => paths.featureSetKey({ upid: 'UP000001584', release: '2025_03', subset: 'all', tag: '../x', ...CONFIG }));
  assert.throws(() => paths.featureSetDir('/lib', '../../etc'));
  assert.throws(() => paths.featureSetDir('/lib', 'UP000001584_2025_03_all_tag'));
});

test('isInside accepts the folder itself and what is below it, never a sibling', () => {
  assert.ok(paths.isInside('/lib', '/lib'));
  assert.ok(paths.isInside('/lib', '/lib/features/x'));
  assert.ok(!paths.isInside('/lib', '/library2'));
  assert.ok(!paths.isInside('/lib', '/lib/../etc'));
});
