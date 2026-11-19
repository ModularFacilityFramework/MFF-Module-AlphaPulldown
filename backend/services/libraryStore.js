// The shared library on disk: UniProt reference proteomes (one immutable copy
// per UniProt release, shared by every user) and the feature sets built from
// them. Layout and naming are in libraryPaths.js; this file does the disk
// work. Downloads run in this process and their progress is polled by the
// frontend, the same way the per-user proteome store worked before.
//
// Every proteome folder carries metadata.json beside proteome.fasta, so the
// library is documented on disk as well as in the database: if the database
// were lost, the sidecars alone say what each file is and where it came from.
const fs = require('fs').promises;
const path = require('path');
const { parseUniprotFasta } = require('./proteomeIndex');
const uniprot = require('./uniprotClient');
const paths = require('./libraryPaths');
const manifest = require('../../module.manifest.json');

const SOURCE = 'UniProt REST API (rest.uniprot.org), uniprotkb/stream';
const MAX_CACHED_INDEXES = 2;
const FEATURE_FILE = /_af3_input\.json(\.xz)?$/;
const GROUP_WRITABLE = 0o2775;

const downloads = new Map(); // `${upid}:${subset}` -> state
const indexes = new Map(); // absolute file path -> { mtimeMs, entries }

const README = `AlphaPulldown shared library (MFF-Module-AlphaPulldown)

proteomes/<UPID>/<UniProt release>/<all|reviewed>/
    proteome.fasta   one UniProt reference proteome, exactly as downloaded
    metadata.json    organism, taxon, release, download date, SHA-256, source
features/<feature set>/
    set.json                     the build configuration, software and databases
    <name>_af3_input.json.xz     AlphaPulldown input features, one per protein

Folders are immutable: a newer UniProt release or a new software/database
configuration is a new folder, never an edit. Do not copy these files into
project folders; jobs link to them.
`;

// Creates the folders and the README, and proves the backend can write there.
async function ensureLayout(libraryDir) {
  if (!paths.isValidLibraryDir(libraryDir)) throw new Error('The library folder must be an absolute path of plain characters.');
  for (const dir of [libraryDir, path.join(libraryDir, 'proteomes'), path.join(libraryDir, 'features')]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, GROUP_WRITABLE).catch(() => {});
  }
  const probe = path.join(libraryDir, `.write-test-${process.pid}`);
  await fs.writeFile(probe, 'ok');
  await fs.rm(probe, { force: true });
  await fs.writeFile(path.join(libraryDir, 'README.txt'), README, { flag: 'wx' }).catch(err => {
    if (err.code !== 'EEXIST') throw err;
  });
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function subsetOf(reviewedOnly) {
  return reviewedOnly ? 'reviewed' : 'all';
}

function downloadsList() {
  return [...downloads.values()];
}

// Starts (or returns the running) download of one proteome. onDone(record)
// is awaited when the files are in place - the route writes the database row
// there. A proteome release the library already holds is not downloaded again.
function startDownload({ libraryDir, upid, reviewedOnly, onDone }) {
  const subset = subsetOf(reviewedOnly);
  const key = `${upid}:${subset}`;
  const running = downloads.get(key);
  if (running && running.state === 'downloading') return running;

  const state = { key, upid, subset, state: 'downloading', bytes: 0, release: '', error: null };
  downloads.set(key, state);

  (async () => {
    const live = await uniprot.peekRelease({ upid, reviewedOnly });
    if (!paths.RELEASE.test(live.release)) throw new Error('UniProt did not report a release for this proteome');
    state.release = live.release;
    const wanted = paths.proteomeDir(libraryDir, { upid, release: live.release, subset });
    const existing = await readJson(path.join(wanted, paths.PROTEOME_META));
    if (existing) {
      state.alreadyHeld = true;
      await onDone(existing);
      return;
    }
    const incoming = path.join(libraryDir, 'proteomes', `.incoming-${upid}-${subset}-${process.pid}`);
    await fs.rm(incoming, { recursive: true, force: true });
    await fs.mkdir(incoming, { recursive: true });
    try {
      const info = await uniprot.proteomeInfo(upid);
      const got = await uniprot.downloadProteome({
        upid, reviewedOnly, destPath: path.join(incoming, paths.PROTEOME_FILE), onBytes: n => { state.bytes = n; }
      });
      if (!paths.RELEASE.test(got.release)) throw new Error('UniProt did not report a release with the download');
      state.release = got.release;
      const metadata = {
        schema: 1,
        upid,
        subset,
        organism: info.organism,
        taxId: info.taxId,
        mnemonic: info.mnemonic,
        strain: info.strain,
        proteomeType: info.proteomeType,
        proteomeModified: info.modified,
        genomeAssembly: info.genomeAssembly,
        busco: info.busco,
        lineage: info.lineage,
        uniprot: { release: got.release, releaseDate: got.releaseDate, subset, entries: got.entries, proteomeProteinCount: info.proteinCount },
        file: { name: paths.PROTEOME_FILE, bytes: got.bytes, sha256: got.sha256 },
        source: SOURCE,
        downloadedAt: new Date().toISOString(),
        addedBy: `${manifest.id} ${manifest.version}`
      };
      await fs.writeFile(path.join(incoming, paths.PROTEOME_META), `${JSON.stringify(metadata, null, 2)}\n`);
      const finalDir = paths.proteomeDir(libraryDir, { upid, release: got.release, subset });
      const held = await readJson(path.join(finalDir, paths.PROTEOME_META));
      if (held) {
        // The release moved on between the check and the download and the
        // new one is already here: keep the one copy.
        await fs.rm(incoming, { recursive: true, force: true });
        await onDone(held);
        return;
      }
      await fs.mkdir(path.dirname(finalDir), { recursive: true });
      await fs.rename(incoming, finalDir);
      await fs.chmod(finalDir, GROUP_WRITABLE).catch(() => {});
      await onDone(metadata);
    } catch (err) {
      await fs.rm(incoming, { recursive: true, force: true });
      throw err;
    }
  })()
    .then(() => { state.state = 'done'; })
    .catch(err => { state.state = 'error'; state.error = err.message; });
  return state;
}

async function readProteomeMetadata(libraryDir, version) {
  return readJson(path.join(paths.proteomeDir(libraryDir, version), paths.PROTEOME_META));
}

async function loadIndex(libraryDir, version) {
  const filePath = path.join(paths.proteomeDir(libraryDir, version), paths.PROTEOME_FILE);
  const stat = await fs.stat(filePath);
  const cached = indexes.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entries;
  const entries = parseUniprotFasta(await fs.readFile(filePath, 'utf8'));
  indexes.delete(filePath);
  indexes.set(filePath, { mtimeMs: stat.mtimeMs, entries });
  while (indexes.size > MAX_CACHED_INDEXES) indexes.delete(indexes.keys().next().value);
  return entries;
}

async function removeProteome(libraryDir, version) {
  const dir = paths.proteomeDir(libraryDir, version);
  indexes.delete(path.join(dir, paths.PROTEOME_FILE));
  await fs.rm(dir, { recursive: true, force: true });
}

// Creates the folder of one feature set and its set.json (the immutable part:
// which proteome version and which build configuration). The software and
// database record is added by the first job that builds into the set.
async function ensureFeatureSet(libraryDir, key, description) {
  const dir = paths.featureSetDir(libraryDir, key);
  await fs.mkdir(path.join(dir, paths.LOCKS_DIRNAME), { recursive: true });
  await fs.chmod(dir, GROUP_WRITABLE).catch(() => {});
  await fs.chmod(path.join(dir, paths.LOCKS_DIRNAME), GROUP_WRITABLE).catch(() => {});
  const file = path.join(dir, paths.SET_FILE);
  const body = { schema: 1, key, ...description, createdAt: new Date().toISOString(), environment: null };
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o664 }).catch(err => {
    if (err.code !== 'EEXIST') throw err;
  });
  return dir;
}

async function readFeatureSet(libraryDir, key) {
  return readJson(path.join(paths.featureSetDir(libraryDir, key), paths.SET_FILE));
}

async function countFeatures(libraryDir, key) {
  try {
    const names = await fs.readdir(paths.featureSetDir(libraryDir, key));
    return names.filter(n => FEATURE_FILE.test(n)).length;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

async function removeFeatureSet(libraryDir, key) {
  await fs.rm(paths.featureSetDir(libraryDir, key), { recursive: true, force: true });
}

module.exports = {
  ensureLayout,
  subsetOf,
  downloadsList,
  startDownload,
  readProteomeMetadata,
  loadIndex,
  removeProteome,
  ensureFeatureSet,
  readFeatureSet,
  countFeatures,
  removeFeatureSet
};
