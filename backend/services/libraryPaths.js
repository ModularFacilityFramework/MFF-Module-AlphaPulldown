// Where things live inside the shared library, and how they are named. Pure
// functions - no disk, no database - so the layout is unit-tested and every
// path a route or a generated script uses comes from exactly one place.
//
//   <library_dir>/
//     README.txt
//     proteomes/<UPID>/<release>/<all|reviewed>/proteome.fasta
//                                              /metadata.json
//     features/<feature set key>/set.json
//                               /<name>_af3_input.json.xz   (one per protein)
//                               /.locks/                    (per-protein locks)
//
// A proteome folder is immutable: a newer UniProt release is a new folder next
// to it. A feature set is tied to ONE proteome version and ONE build
// configuration (see featureSetKey), so a file in it can only ever belong to
// the sequence that proteome version holds.
const crypto = require('crypto');
const path = require('path');

const UPID = /^UP\d{9}$/;
// UniProt release names look like 2025_03.
const RELEASE = /^\d{4}_\d{2}$/;
const SUBSETS = ['all', 'reviewed'];
const TAG = /^[A-Za-z0-9][\w.-]{0,31}$/;
// An absolute path of plain characters; ends up inside generated scripts.
const LIBRARY_DIR = /^\/[\w./-]{1,499}$/;

const PROTEOME_FILE = 'proteome.fasta';
const PROTEOME_META = 'metadata.json';
const SET_FILE = 'set.json';
const FEATURE_FORMAT = 'af3_json';
const LOCKS_DIRNAME = '.locks';

function isValidLibraryDir(dir) {
  return typeof dir === 'string' && LIBRARY_DIR.test(dir) && !dir.split('/').some(seg => seg === '..' || seg === '.');
}

function assertPart(value, pattern, what) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${what}`);
  return value;
}

function proteomeDir(libraryDir, { upid, release, subset }) {
  assertPart(upid, UPID, 'proteome id');
  assertPart(release, RELEASE, 'UniProt release');
  if (!SUBSETS.includes(subset)) throw new Error('Invalid proteome subset');
  return path.join(libraryDir, 'proteomes', upid, release, subset);
}

// The shortest text that tells two build configurations apart: what changes
// the features (the pipeline format, the template cut-off, the database
// folder) - not who asked for them. 8 hex characters of its hash.
function configHash({ format, maxTemplateDate, dataDir }) {
  const text = JSON.stringify([format, maxTemplateDate, dataDir]);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

// <UPID>_<release>_<subset>_<tag>_<config hash>: readable in a directory
// listing, unique per proteome version and configuration.
function featureSetKey({ upid, release, subset, tag, format, maxTemplateDate, dataDir }) {
  assertPart(upid, UPID, 'proteome id');
  assertPart(release, RELEASE, 'UniProt release');
  if (!SUBSETS.includes(subset)) throw new Error('Invalid proteome subset');
  assertPart(tag, TAG, 'feature set tag');
  return `${upid}_${release}_${subset}_${tag}_${configHash({ format, maxTemplateDate, dataDir })}`;
}

function featureSetDir(libraryDir, key) {
  assertPart(key, SET_KEY, 'feature set key');
  return path.join(libraryDir, 'features', key);
}

const SET_KEY = /^UP\d{9}_\d{4}_\d{2}_(all|reviewed)_[A-Za-z0-9][\w.-]{0,31}_[0-9a-f]{8}$/;

// The feature set a file belongs to, from the path of the file (for example
// where a project's link points): the folder directly under features/, or
// null for a path outside the library or not inside a set.
function featureSetKeyOfPath(libraryDir, filePath) {
  const base = path.join(path.resolve(libraryDir), 'features') + path.sep;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(base)) return null;
  const key = resolved.slice(base.length).split(path.sep)[0];
  return SET_KEY.test(key) ? key : null;
}

function isInside(base, candidate) {
  const b = path.resolve(base);
  const c = path.resolve(candidate);
  return c === b || c.startsWith(b + path.sep);
}

module.exports = {
  UPID,
  RELEASE,
  SUBSETS,
  TAG,
  PROTEOME_FILE,
  PROTEOME_META,
  SET_FILE,
  FEATURE_FORMAT,
  LOCKS_DIRNAME,
  isValidLibraryDir,
  proteomeDir,
  configHash,
  featureSetKey,
  featureSetDir,
  featureSetKeyOfPath,
  isInside
};
