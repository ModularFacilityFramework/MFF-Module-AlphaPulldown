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

module.exports = { MODULE_DIRNAME, projectDir, isSafeRelativePath, isInside };
