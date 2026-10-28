// Downloaded proteomes live as plain FASTA files in the user's own core
// workspace (module-AlphaPulldown/proteomes/), so each user keeps their own
// copy and nothing is shared between users. A parsed copy of the most
// recently used ones is kept in memory so browsing and filtering is instant.
// Downloads run in this process; their progress is polled by the frontend.
const fs = require('fs').promises;
const path = require('path');
const { MODULE_DIRNAME } = require('./projectPaths');
const { parseUniprotFasta } = require('./proteomeIndex');
const uniprot = require('./uniprotClient');

const FILE_PATTERN = /^(UP\d{9})(_reviewed)?\.fasta$/;
const MAX_CACHED_INDEXES = 2;

const downloads = new Map(); // `${userId}:${file}` -> state
const indexes = new Map(); // absolute file path -> { mtimeMs, entries }

function proteomeDir(workspacePath) {
  return path.join(workspacePath, MODULE_DIRNAME, 'proteomes');
}

function fileName(upid, reviewedOnly) {
  return `${upid}${reviewedOnly ? '_reviewed' : ''}.fasta`;
}

async function listLocal(workspacePath) {
  let names;
  try {
    names = await fs.readdir(proteomeDir(workspacePath));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const local = [];
  for (const name of names) {
    const m = FILE_PATTERN.exec(name);
    if (!m) continue;
    const stat = await fs.stat(path.join(proteomeDir(workspacePath), name));
    local.push({ upid: m[1], reviewedOnly: !!m[2], file: name, bytes: stat.size, modified: stat.mtime });
  }
  return local.sort((a, b) => a.file.localeCompare(b.file));
}

function downloadsFor(userId) {
  const prefix = `${userId}:`;
  return [...downloads.entries()].filter(([key]) => key.startsWith(prefix)).map(([, state]) => state);
}

function startDownload({ userId, workspacePath, upid, reviewedOnly }) {
  const file = fileName(upid, reviewedOnly);
  const key = `${userId}:${file}`;
  const existing = downloads.get(key);
  if (existing && existing.state === 'downloading') return existing;

  const state = { file, upid, reviewedOnly, state: 'downloading', bytes: 0, error: null };
  downloads.set(key, state);
  const dir = proteomeDir(workspacePath);
  fs.mkdir(dir, { recursive: true })
    .then(() => uniprot.downloadProteome({
      upid, reviewedOnly, destPath: path.join(dir, file), onBytes: n => { state.bytes = n; }
    }))
    .then(() => { state.state = 'done'; })
    .catch(err => { state.state = 'error'; state.error = err.message; });
  return state;
}

async function loadIndex(workspacePath, upid, reviewedOnly) {
  const filePath = path.join(proteomeDir(workspacePath), fileName(upid, reviewedOnly));
  const stat = await fs.stat(filePath);
  const cached = indexes.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entries;

  const entries = parseUniprotFasta(await fs.readFile(filePath, 'utf8'));
  indexes.delete(filePath);
  indexes.set(filePath, { mtimeMs: stat.mtimeMs, entries });
  while (indexes.size > MAX_CACHED_INDEXES) indexes.delete(indexes.keys().next().value);
  return entries;
}

async function remove(workspacePath, upid, reviewedOnly) {
  const filePath = path.join(proteomeDir(workspacePath), fileName(upid, reviewedOnly));
  indexes.delete(filePath);
  await fs.rm(filePath, { force: true });
}

module.exports = { listLocal, downloadsFor, startDownload, loadIndex, remove };
