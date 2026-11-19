const path = require('path');

// Everything this module writes lives under one folder of the user's core
// workspace, one subfolder per project. Core never looks inside the
// workspace, so this naming is entirely this module's own.
const MODULE_DIRNAME = 'module-AlphaPulldown';

// Absolute path of a project's own folder. Not created here - callers
// mkdir it when they first have something to write.
function projectDir(workspacePath, projectNumber) {
  return path.join(workspacePath, MODULE_DIRNAME, `P${projectNumber}`);
}

const FEATURES_DIRNAME = 'features';
const PREDICTIONS_DIRNAME = 'predictions';

// Where the Features tab leaves <name>_af3_input.json.xz for every protein.
function featuresDir(workspacePath, projectNumber) {
  return path.join(projectDir(workspacePath, projectNumber), FEATURES_DIRNAME);
}

// One prediction job's own folder: its scripts, slurm.out/err and output/.
// Throws if the pieces would put it anywhere but under the project's
// predictions folder.
function predictionJobDir(workspacePath, projectNumber, runId, itemId) {
  const base = path.join(projectDir(workspacePath, projectNumber), PREDICTIONS_DIRNAME);
  const dir = path.join(base, `run-${runId}`, `job-${itemId}`);
  if (!isInside(base, dir) || dir === base) throw new Error('Prediction folder is outside the project');
  return dir;
}

// The JAX compilation cache every job of a project shares, so a model shape
// compiled once is not compiled again by the next job.
function jaxCacheDir(workspacePath, projectNumber) {
  return path.join(projectDir(workspacePath, projectNumber), PREDICTIONS_DIRNAME, 'jax-cache');
}

// A relative path is safe to join onto a project folder if every one of its
// segments is a plain name (letters/digits/./-/_ as characters, never a whole
// segment of "." or ".."). Rejects absolute paths and any path-traversal
// attempt.
function isSafeRelativePath(p) {
  if (!p || path.isAbsolute(p)) return false;
  return p.split('/').every(seg => seg.length > 0 && seg !== '.' && seg !== '..' && /^[\w.-]+$/.test(seg));
}

// True when `candidate` resolves to `base` itself or something inside it -
// the second guard after isSafeRelativePath() before touching the disk.
function isInside(base, candidate) {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(resolvedBase + path.sep);
}

module.exports = { MODULE_DIRNAME, projectDir, featuresDir, predictionJobDir, jaxCacheDir, isSafeRelativePath, isInside };
