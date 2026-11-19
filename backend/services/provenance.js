// What a job records about itself so its methods can be written from it:
// which proteome versions and feature sets it used, how they were built, the
// software and database versions, and the options chosen. Pure functions - no
// disk, no database - so they are unit-tested.
//
// Two kinds of fact, kept apart on purpose:
//  - PLANNED facts the backend knows when it creates a run (proteome version,
//    feature set, Setup values), frozen into the run's provenance_json;
//  - OBSERVED facts only the job can know (the AlphaPulldown/AlphaFold
//    versions of the environment it really ran in, the database files it
//    really saw). The job writes them to environment.json (captureScript
//    below) and the backend merges them in once the job has ended.
// Anything not recorded stays out of the methods text - nothing is guessed.

const CITATION = 'Molodenskiy et al. 2025, Bioinformatics, doi:10.1093/bioinformatics/btaf115';

// Runs inside the activated environment of the feature job, before any
// search. Writes environment.json and, for every feature set the run will
// build into, either records that environment in the set's set.json (the
// first job to build into the set) or checks that it is the same one. A
// different AlphaPulldown/AlphaFold version or different database files
// would put features built two ways into one set, so the job stops (exit 3)
// and says what differs: staff then bump the feature set tag in Setup.
const CAPTURE_SCRIPT = `import fcntl, glob, hashlib, json, os, platform, socket, sys, time
from importlib import metadata

out_path, data_dir, seqres = sys.argv[1], sys.argv[2], sys.argv[3]
set_dirs = sys.argv[4:]

def version(name):
    try:
        return metadata.version(name)
    except Exception:
        return None

def day(seconds):
    return time.strftime('%Y-%m-%d', time.gmtime(seconds))

# The database files the AlphaFold 3 data pipeline reads for protein chains.
USED = ['uniref90_*.fa', 'mgy_clusters_*.fa', 'uniprot_all_*.fa',
        'bfd-first_non_consensus_sequences.fasta', 'pdb_*_mmcif_files.tar']

databases = []
for pattern in USED:
    for path in sorted(glob.glob(os.path.join(data_dir, pattern))):
        st = os.stat(path)
        databases.append({'name': os.path.basename(path), 'bytes': st.st_size, 'modified': day(st.st_mtime)})
if seqres != '-' and os.path.exists(seqres):
    st = os.stat(seqres)
    databases.append({'name': os.path.basename(seqres), 'bytes': st.st_size, 'modified': day(st.st_mtime), 'role': 'pdb_seqres'})
mmcif = os.path.join(data_dir, 'mmcif_files')
if os.path.isdir(mmcif):
    databases.append({'name': 'mmcif_files', 'bytes': None, 'modified': day(os.stat(mmcif).st_mtime), 'role': 'templates'})

software = {
    'alphapulldown': version('alphapulldown'),
    'alphafold3': version('alphafold3'),
    'alphafold': version('alphafold'),
    'jax': version('jax'),
    'python': platform.python_version(),
}
if software['alphapulldown'] is None:
    sys.stderr.write('AlphaPulldown is not installed in this environment; check the environment name in Setup.\\n')
    sys.exit(5)

fingerprint = hashlib.sha256(json.dumps({
    'alphapulldown': software['alphapulldown'],
    'alphafold3': software['alphafold3'],
    'databases': sorted((d['name'], d['bytes']) for d in databases if d['bytes'] is not None),
}, sort_keys=True).encode()).hexdigest()

env = {
    'schema': 1,
    'capturedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'host': socket.gethostname(),
    'software': software,
    'databases': databases,
    'fingerprint': fingerprint,
}
with open(out_path, 'w') as handle:
    json.dump(env, handle, indent=2)

for set_dir in set_dirs:
    set_file = os.path.join(set_dir, 'set.json')
    lock_path = os.path.join(set_dir, '.locks', 'set.lock')
    if not os.path.isfile(set_file) or not os.path.isdir(os.path.dirname(lock_path)):
        sys.stderr.write('The feature set folder %s is missing or incomplete; it is created by the module when the run starts.\\n' % set_dir)
        sys.exit(4)
    with open(lock_path, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(set_file) as handle:
                record = json.load(handle)
        except Exception as err:
            sys.stderr.write('Cannot read %s: %s\\n' % (set_file, err))
            sys.exit(4)
        known = record.get('environment')
        if known is None:
            record['environment'] = env
            tmp = set_file + '.tmp'
            with open(tmp, 'w') as handle:
                json.dump(record, handle, indent=2)
            os.chmod(tmp, 0o664)
            os.replace(tmp, set_file)
        elif known.get('fingerprint') != fingerprint:
            sys.stderr.write('Feature set %s was built with different software or databases.\\n' % record.get('key'))
            sys.stderr.write('  recorded: AlphaPulldown %s, AlphaFold 3 %s\\n' % (known['software'].get('alphapulldown'), known['software'].get('alphafold3')))
            sys.stderr.write('  here:     AlphaPulldown %s, AlphaFold 3 %s\\n' % (software['alphapulldown'], software['alphafold3']))
            then = set((d['name'], d['bytes']) for d in known.get('databases', []) if d.get('bytes') is not None)
            now = set((d['name'], d['bytes']) for d in databases if d['bytes'] is not None)
            for name, size in sorted(then - now):
                sys.stderr.write('  recorded database not found as it was: %s (%s bytes)\\n' % (name, size))
            for name, size in sorted(now - then):
                sys.stderr.write('  database not in the recorded set:      %s (%s bytes)\\n' % (name, size))
            sys.stderr.write('  The databases or software changed: ask staff to change the feature set tag in Setup.\\n')
            sys.exit(3)
`;

// "uniref90_2022_05.fa" -> { label: 'UniRef90', version: '2022_05' } and so on
// for the files the pipeline reads; anything else keeps its file name.
const DATABASE_LABELS = [
  [/^uniref90_(\d{4}_\d{2})\.fa$/, 'UniRef90', m => m[1]],
  [/^mgy_clusters_(\d{4}_\d{2})\.fa$/, 'MGnify', m => m[1]],
  [/^uniprot_all_(\d{4}_\d{2})\.fa$/, 'UniProt', m => m[1]],
  [/^bfd-first_non_consensus_sequences\.fasta$/, 'BFD (first non-consensus sequences)', () => null],
  [/^pdb_(\d{4})_(\d{2})_(\d{2})_mmcif_files\.tar$/, 'PDB mmCIF templates', m => `${m[1]}-${m[2]}-${m[3]}`]
];

function describeDatabases(databases) {
  return (Array.isArray(databases) ? databases : []).map(d => {
    const known = DATABASE_LABELS.map(([pattern, label, versionOf]) => {
      const m = pattern.exec(d.name || '');
      return m ? { label, version: versionOf(m) } : null;
    }).find(Boolean);
    if (d.role === 'pdb_seqres') return { label: 'PDB seqres', version: null, modified: d.modified, file: d.name };
    if (d.role === 'templates') return { label: 'PDB mmCIF files', version: null, modified: d.modified, file: d.name };
    if (known) return { ...known, modified: d.modified, file: d.name };
    return { label: d.name, version: null, modified: d.modified, file: d.name };
  });
}

// One entry per proteome version a run touched. rows: [{ proteome, set,
// count }] where proteome is a library proteome row (with parsed metadata),
// set is the feature set row or null (features kept in the project), count
// how many of the run's proteins come from it.
function proteomeRecords(groups) {
  return groups.map(g => ({
    proteomeId: Number(g.proteome.id),
    upid: g.proteome.upid,
    organism: g.proteome.organism,
    taxId: g.proteome.tax_id === undefined ? g.proteome.taxId : g.proteome.tax_id,
    proteomeType: g.proteome.proteome_type || g.proteome.proteomeType || '',
    release: g.proteome.release_name || g.proteome.release,
    releaseDate: g.proteome.release_date || g.proteome.releaseDate || '',
    subset: g.proteome.subset,
    entries: g.proteome.entries,
    sha256: g.proteome.sha256,
    source: g.proteome.source,
    downloadedAt: g.proteome.downloaded_at || g.proteome.downloadedAt || null,
    featureSet: g.set
      ? {
        id: Number(g.set.id),
        key: g.set.set_key || g.set.key,
        tag: g.set.tag,
        format: g.set.format,
        maxTemplateDate: g.set.max_template_date || g.set.maxTemplateDate
      }
      : null,
    proteins: g.count
  }));
}

// The frozen, planned record of one feature run (stored when it is created).
function featureRunRecord({ module, settings, redo, groups, localProteins, total, createdAt }) {
  return {
    schema: 1,
    kind: 'features',
    createdAt,
    module,
    pipeline: 'AlphaPulldown create_individual_features.py, AlphaFold 3 data pipeline (--data_pipeline=alphafold3)',
    settings: {
      environment: settings.env_name,
      databaseDir: settings.data_dir,
      pdbSeqres: settings.pdb_seqres_path || null,
      maxTemplateDate: settings.max_template_date,
      redo: !!redo
    },
    proteins: { total, fromLibrary: total - localProteins, local: localProteins },
    proteomes: proteomeRecords(groups),
    environment: null
  };
}

// The record of one prediction run: the same proteome/feature-set facts for
// the proteins it folds, plus the options chosen for the ABCFold module.
function cofoldRunRecord({ module, mode, options, groups, localProteins, pairs, createdAt }) {
  return {
    schema: 1,
    kind: 'cofold',
    createdAt,
    module,
    mode,
    pairs,
    options,
    proteins: { fromLibrary: groups.reduce((n, g) => n + g.count, 0), local: localProteins },
    proteomes: proteomeRecords(groups)
  };
}

// Adds what the finished job observed. Never overwrites a planned fact.
function withEnvironment(record, environment) {
  if (!record || !environment || typeof environment !== 'object') return record;
  return { ...record, environment };
}

function listNames(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function proteomeSentence(records) {
  if (records.length === 0) return '';
  const parts = records.map(r => {
    const bits = [r.upid, `UniProt release ${r.release}${r.releaseDate ? ` of ${r.releaseDate}` : ''}`,
      r.subset === 'reviewed' ? 'reviewed (Swiss-Prot) entries only' : 'all entries'];
    if (r.entries) bits.push(`${r.entries.toLocaleString('en-GB')} sequences`);
    if (r.sha256) bits.push(`library copy SHA-256 ${r.sha256.slice(0, 12)}`);
    return `${r.organism}${r.taxId ? ` (taxon ${r.taxId})` : ''} (${bits.join('; ')})`;
  });
  return `Protein sequences were taken from the UniProt ${records.length > 1 ? 'proteomes' : 'proteome'} of ${listNames(parts)}.`;
}

function featureSentence(feature) {
  if (!feature) return '';
  const env = feature.environment;
  const sw = env && env.software ? env.software : null;
  const tool = sw && sw.alphapulldown ? `AlphaPulldown ${sw.alphapulldown}` : 'AlphaPulldown';
  const af = sw && sw.alphafold3 ? ` (AlphaFold 3 ${sw.alphafold3} data pipeline)` : ' (AlphaFold 3 data pipeline)';
  const dbs = env ? describeDatabases(env.databases).filter(d => d.label !== 'PDB mmCIF files') : [];
  const dbText = dbs.map(d => (d.version ? `${d.label} ${d.version}` : `${d.label}${d.modified ? ` (file dated ${d.modified})` : ''}`));
  const searched = dbText.length > 0 ? ` by searching ${listNames(dbText)}` : ' by searching the local genetic databases';
  const date = feature.settings && feature.settings.maxTemplateDate;
  const sets = [...new Set(feature.proteomes.filter(p => p.featureSet).map(p => p.featureSet.key))];
  const shared = sets.length > 0 ? ` Features were computed once per protein and shared through the feature ${sets.length > 1 ? 'sets' : 'set'} ${listNames(sets)}.` : '';
  return `Input features were generated with ${tool}${af}${searched}${date ? `, with a maximum template date of ${date}` : ''}.${shared}`;
}

function cofoldSentence(cofold) {
  if (!cofold) return '';
  const o = cofold.options || {};
  const search = o.mmseqs2 === 'yes' ? 'MMseqs2 server' : o.mmseqs2 === 'no' ? 'local databases' : 'the ABCFold module\'s default search';
  const seeds = o.seeds || o.modelSeeds;
  return `Complexes (${cofold.pairs} in this run, ${cofold.mode === 'pulldown' ? 'every bait against every candidate' : cofold.mode === 'all_vs_all' ? 'all pairs' : 'homo-oligomers'}) were predicted with AlphaFold 3 through the ABCFold module${seeds ? `, ${seeds} model seed${seeds === 1 ? '' : 's'}` : ''}, MSA search: ${search}, templates ${o.templates ? 'on' : 'off'}${o.gpuCount ? `, ${o.gpuCount} GPU${o.gpuCount === 1 ? '' : 's'} per job` : ''}.`;
}

// The paragraph for a methods section, from the project's latest feature and
// prediction records (either may be missing). Returns { text, missing }:
// missing lists the facts that were not recorded, so the user can see why a
// sentence is absent.
function methodsText({ feature, cofold }) {
  const source = feature || cofold;
  const missing = [];
  if (!feature) missing.push('No finished feature run is recorded for this project.');
  else if (!feature.environment) missing.push('The feature run has not ended yet, so its software and database versions are not recorded.');
  if (!cofold) missing.push('No prediction run is recorded for this project.');
  const sentences = [
    source ? proteomeSentence(source.proteomes) : '',
    featureSentence(feature),
    cofoldSentence(cofold),
    `If you use AlphaPulldown, please cite ${CITATION}.`
  ].filter(Boolean);
  return { text: sentences.join(' '), missing };
}

module.exports = {
  CITATION,
  CAPTURE_SCRIPT,
  describeDatabases,
  proteomeRecords,
  featureRunRecord,
  cofoldRunRecord,
  withEnvironment,
  methodsText
};
