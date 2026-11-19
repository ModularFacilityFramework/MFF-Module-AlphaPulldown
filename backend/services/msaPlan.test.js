const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const plan = require('./msaPlan');

const SETTINGS = {
  env_manager: 'micromamba',
  env_name: 'alphafold3_alphapulldown',
  data_dir: '/data/af3',
  pdb_seqres_path: '/data/af3/pdb_seqres/pdb_seqres.txt',
  max_template_date: '2050-01-01',
  msa_partition: 'cpu',
  msa_cpus_per_task: 8,
  msa_mem: '64G',
  msa_time: '10:00:00',
  msa_array_throttle: 4,
  slurm_mail_type: 'END,FAIL'
};

test('slurm times parse and format in both directions', () => {
  assert.strictEqual(plan.parseSlurmTime('10:00:00'), 36000);
  assert.strictEqual(plan.parseSlurmTime('90'), 5400);
  assert.strictEqual(plan.parseSlurmTime('5:30'), 330);
  assert.strictEqual(plan.parseSlurmTime('1-12'), 129600);
  assert.strictEqual(plan.parseSlurmTime('1-02:03:04'), 93784);
  assert.strictEqual(plan.parseSlurmTime('nonsense'), null);
  assert.strictEqual(plan.formatSlurmTime(36000), '10:00:00');
  assert.strictEqual(plan.formatSlurmTime(93784), '1-02:03:04');
  assert.strictEqual(plan.formatSlurmTime(59.2), '00:01:00');
});

test('memory strings become megabytes', () => {
  assert.strictEqual(plan.parseMemMB('64G'), 65536);
  assert.strictEqual(plan.parseMemMB('512M'), 512);
  assert.strictEqual(plan.parseMemMB('2T'), 2097152);
  assert.strictEqual(plan.parseMemMB('2048'), 2048);
  assert.strictEqual(plan.parseMemMB('2048K'), 2);
  assert.strictEqual(plan.parseMemMB('x'), null);
});

test('the allocation holds one slot per protein searched at once, time scales with rounds', () => {
  const r = plan.msaResources(SETTINGS, 10);
  assert.strictEqual(r.parallel, 4);
  assert.strictEqual(r.rounds, 3);
  assert.strictEqual(r.cpus, 32);
  assert.strictEqual(r.mem, '262144M');
  assert.strictEqual(r.timeSeconds, 3 * 36000);
  assert.strictEqual(r.time, '1-06:00:00');
});

test('fewer proteins than slots only asks for what is needed', () => {
  const r = plan.msaResources(SETTINGS, 2);
  assert.deepStrictEqual([r.parallel, r.rounds, r.cpus], [2, 1, 16]);
  assert.strictEqual(plan.msaResources(SETTINGS, 0).parallel, 1);
});

test('a run needs a database directory', () => {
  assert.strictEqual(plan.msaProblems(SETTINGS).length, 0);
  assert.strictEqual(plan.msaProblems({ ...SETTINGS, data_dir: '' }).length, 1);
});

test('feature files are recognised plain or compressed, and by nothing else', () => {
  assert.strictEqual(plan.featureNameOf('P12345_af3_input.json'), 'P12345');
  assert.strictEqual(plan.featureNameOf('P12345_af3_input.json.xz'), 'P12345');
  assert.strictEqual(plan.featureNameOf('my_prot.v2_af3_input.json.xz'), 'my_prot.v2');
  ['P12345.pkl', 'P12345.json', 'P12345_af3_input.json.gz', 'P12345_feature_metadata_2026-01-01.json', '_af3_input.json'].forEach(n => assert.strictEqual(plan.featureNameOf(n), null, n));
});

test('proteins are unique by name; a name with two sequences is a conflict', () => {
  const rows = [
    { name: 'A', length: 3, sequence: 'AAA' }, { name: 'B', length: 3, sequence: 'CCC' },
    { name: 'A', length: 3, sequence: 'AAA' }, { name: 'B', length: 3, sequence: 'DDD' }
  ];
  const { proteins, conflicts } = plan.uniqueProteins(rows);
  assert.deepStrictEqual(proteins.map(p => p.name), ['A', 'B']);
  assert.deepStrictEqual(conflicts, ['B']);
});

test('timings: bad lines are ignored, a retry keeps its last line', () => {
  const text = [
    '1\t300\t120\t0\tok', 'garbage', '2\t200\t0\t0\tskipped', '3\t400\t50\t1\tfailed',
    '3\t400\t80\t0\tok', '4\t100\t-5\t0\tok', '5\t100\t10\t137\toom', '6\t100\t10\t0\tweird', ''
  ].join('\n');
  const timings = plan.parseTimings(text);
  assert.deepStrictEqual(timings.map(t => [t.index, t.status]), [[1, 'ok'], [2, 'skipped'], [3, 'ok'], [5, 'oom']]);
  assert.deepStrictEqual(plan.progressOf(timings), { searched: 2, skipped: 1, failed: 1 });
});

test('skipped proteins give no speed sample, failures do', () => {
  const timings = plan.parseTimings('1\t300\t120\t0\tok\n2\t200\t0\t0\tskipped\n3\t100\t10\t137\toom\n');
  const samples = plan.samplesFromTimings(timings, { method: 'local', hardware: 'cpu/8cpu' });
  assert.deepStrictEqual(samples.map(s => [s.lenA, s.outcome, s.runSeconds]), [[300, 'ok', 120], [100, 'oom', 10]]);
  assert.ok(samples.every(s => s.stage === 'msa' && s.method === 'local'));
});

test('terminal states are recognised however Slurm words them', () => {
  ['COMPLETED', 'CANCELLED by 1000', 'CANCELLED+', 'TIMEOUT', 'OUT_OF_MEMORY'].forEach(s => assert.ok(plan.isTerminalState(s), s));
  ['PENDING', 'RUNNING', 'COMPLETING', '', undefined].forEach(s => assert.ok(!plan.isTerminalState(s), String(s)));
});

test('shell quoting survives a quote and refuses a newline', () => {
  assert.strictEqual(plan.shellQuote('/a b/c'), '\'/a b/c\'');
  assert.strictEqual(plan.shellQuote('/it\'s'), '\'/it\'\\\'\'s\'');
  assert.throws(() => plan.shellQuote('/a\nb'));
});

test('the submit script carries the resources, the activation and the xargs loop', () => {
  const resources = plan.msaResources(SETTINGS, 10);
  const script = plan.buildSubmitScript({ slug: 'ap-msa-P3', settings: SETTINGS, email: 'a@b.org', resources, count: 10 });
  assert.match(script, /^#!\/bin\/bash -i/);
  assert.match(script, /#SBATCH --job-name=ap-msa-P3/);
  assert.match(script, /#SBATCH --partition=cpu/);
  assert.match(script, /#SBATCH --cpus-per-task=32/);
  assert.match(script, /#SBATCH --time=1-06:00:00/);
  assert.match(script, /#SBATCH --mail-user=a@b.org/);
  assert.match(script, /micromamba activate alphafold3_alphapulldown/);
  assert.match(script, /seq 1 10 \| xargs -P 4 -n 1 bash \.\/run_one\.sh/);
  assert.ok(!/set -e/.test(script));
  const bare = plan.buildSubmitScript({ slug: 's', settings: { ...SETTINGS, msa_partition: '', env_manager: 'conda' }, resources, count: 10 });
  assert.ok(!bare.includes('--partition') && !bare.includes('--mail-user'));
  assert.match(bare, /conda activate alphafold3_alphapulldown/);
});

test('the per-protein command runs AlphaFold 3\'s pipeline against the local databases', () => {
  const normal = plan.buildRunOneScript(SETTINGS, { featuresDir: '/ws/P1/features', redo: false });
  ['--data_pipeline=alphafold3', '--data_dir=\'/data/af3\'', '--compress_features=True', '--max_template_date=2050-01-01',
    '--pdb_seqres_database_path=\'/data/af3/pdb_seqres/pdb_seqres.txt\'', '--skip_existing=True'].forEach(f => assert.ok(normal.includes(f), f));
  assert.ok(!normal.includes('mmseqs'), 'AlphaFold 3 refuses --use_mmseqs2');
  assert.ok(normal.includes('_af3_input.json.xz'), 'a finished protein is recognised by its feature file');
  const redo = plan.buildRunOneScript({ ...SETTINGS, pdb_seqres_path: '' }, { featuresDir: '/ws/P1/features', redo: true });
  assert.ok(!redo.includes('skip_existing') && !redo.includes('[ -e') && !redo.includes('pdb_seqres'));
});

test('both scripts are valid bash', () => {
  const resources = plan.msaResources(SETTINGS, 3);
  const files = plan.buildRunFiles({
    slug: 'x', settings: SETTINGS, email: '', resources, featuresDir: '/ws/it\'s here/features', redo: false,
    proteins: [{ name: 'A', length: 10, sequence: 'A'.repeat(10) }]
  });
  ['submit.sh', 'run_one.sh'].forEach(name => {
    const result = spawnSync('bash', ['-n'], { input: files[name] });
    assert.strictEqual(result.status, 0, `${name}: ${result.stderr}`);
  });
});

// Runs the generated scripts for real, with a stand-in for AlphaPulldown on
// PATH: it "searches" for a moment, writes <name>.pkl, fails for one protein
// and is killed (137) for another.
test('run_one.sh and the xargs loop: timings, skip, failure and parallelism', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-plan-'));
  try {
    const bin = path.join(dir, 'bin');
    const run = path.join(dir, 'run');
    const features = path.join(dir, 'fe atures');
    [bin, run, features].forEach(d => fs.mkdirSync(d));
    fs.writeFileSync(path.join(bin, 'create_individual_features.py'), [
      '#!/bin/bash',
      // eslint-disable-next-line no-template-curly-in-string
      'for a in "$@"; do case "$a" in --seq_index=*) i="${a#--seq_index=}";; --output_dir=*) out="${a#--output_dir=}";; esac; done',
      'name=$(sed -n -e "$i p" msa_names.txt)',
      'echo "$@" > "args.$i.txt"',
      'sleep 1',
      'if [ "$name" = BAD ]; then echo boom >&2; exit 1; fi',
      'if [ "$name" = KILLED ]; then exit 137; fi',
      // eslint-disable-next-line no-template-curly-in-string
      'touch "$out/${name}_af3_input.json.xz"',
      ''
    ].join('\n'), { mode: 0o755 });

    const proteins = ['AAA', 'BAD', 'CCC', 'KILLED', 'DDD', 'EEE'].map(name => ({ name, length: name === 'BAD' ? 50 : 100, sequence: 'M'.repeat(10) }));
    fs.writeFileSync(path.join(features, 'CCC_af3_input.json'), '');
    const settings = { ...SETTINGS, msa_array_throttle: 3 };
    const resources = plan.msaResources(settings, proteins.length);
    const files = plan.buildRunFiles({ slug: 'x', settings, email: '', resources, proteins, featuresDir: features, redo: false });
    // the real submit.sh starts with an environment activation that does not exist here
    const loop = files['submit.sh'].split('\n').filter(l => l.startsWith('mkdir') || l.startsWith('seq ')).join('\n');
    Object.entries(files).forEach(([name, content]) => fs.writeFileSync(path.join(run, name), content));
    fs.chmodSync(path.join(run, 'run_one.sh'), 0o755);

    const started = Date.now();
    const result = spawnSync('bash', ['-c', loop], { cwd: run, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const seconds = (Date.now() - started) / 1000;

    assert.notStrictEqual(result.status, 0, 'a failed protein must make the job fail');
    const timings = plan.parseTimings(fs.readFileSync(path.join(run, 'timings.tsv'), 'utf8'));
    assert.deepStrictEqual(timings.map(t => [t.index, t.status]), [[1, 'ok'], [2, 'failed'], [3, 'skipped'], [4, 'oom'], [5, 'ok'], [6, 'ok']]);
    assert.strictEqual(timings[3].exit, 137);
    assert.ok(timings[0].seconds >= 1 && timings[0].seconds <= 3);
    assert.strictEqual(timings[2].seconds, 0);
    assert.ok(fs.existsSync(path.join(features, 'AAA_af3_input.json.xz')) && fs.existsSync(path.join(features, 'EEE_af3_input.json.xz')));
    assert.ok(!fs.existsSync(path.join(run, 'args.3.txt')), 'the skipped protein must not be searched');
    assert.match(fs.readFileSync(path.join(run, 'logs', '2.log'), 'utf8'), /boom/);
    assert.match(fs.readFileSync(path.join(run, 'args.1.txt'), 'utf8'), /--data_dir=\/data\/af3 .*--seq_index=1/);
    assert.ok(seconds < 4.5, `five 1-second searches, three at a time, took ${seconds}s`);
    assert.ok(!fs.readFileSync(path.join(run, 'timings.tsv'), 'utf8').includes('AAA'), 'timings must hold no names');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
