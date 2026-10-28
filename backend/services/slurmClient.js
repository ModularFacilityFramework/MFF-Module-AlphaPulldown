// Thin wrapper around coreApi.callModule() for the Slurm module's own
// /external/* routes. There is no coreApi.slurm.* and never will be - core
// stays generic on principle (see docs/MFF-Core_module-core-api.md's
// callModule section); naming and interpreting a specific module's API is
// this module's own job, built on top of that one generic primitive.
//
// Every function here takes the CALLING USER's own token
// (req.headers.authorization, passed straight through - never a service/
// admin identity) and coreApi itself. callModule never throws - "module
// not installed", network errors, and non-2xx responses all come back as
// { ok: false, status, error } uniformly - so none of these wrappers need
// try/catch either, they just check r.ok.

// Failures keep their status/error so callers can tell "this person is not a
// registered Slurm user" (403, a per-user rejection documented in
// docs/MFF-Module-SLURM_slurm-config.md's "Access gate") apart from "the
// Slurm module is unreachable" - the two need different messages.
async function listGpuPartitions(coreApi, token) {
  const r = await coreApi.callModule(token, 'slurm', 'GET', '/external/gpu-partitions');
  return r.ok ? { data: r.data, status: 200, error: null } : { data: [], status: r.status, error: r.error };
}

// workDir must already exist on disk and already contain a submit.sh
// script plus any input files the job needs, written there by the CALLER
// (this module) before this is ever called. The Slurm module treats workDir
// as an opaque string, passed straight to `sbatch --chdir` - it never
// creates, writes into, or reads it itself (docs/MFF-Module-SLURM_slurm-config.md).
async function submitJob(coreApi, token, { workDir, jobName }) {
  const r = await coreApi.callModule(token, 'slurm', 'POST', '/external/jobs', {
    body: { workDir, jobName }
  });
  if (!r.ok) return { success: false, error: r.error, status: r.status };
  return { success: true, jobId: r.data.jobId };
}

async function getJobStatus(coreApi, token, jobId) {
  const r = await coreApi.callModule(token, 'slurm', 'GET', `/external/jobs/${jobId}`);
  if (!r.ok) return { success: false, error: r.error, status: r.status };
  return { success: true, ...r.data };
}

// No listJobFiles/downloadJobFile here - the Slurm module provides no
// file-listing/download routes at all (it never reads workDir's contents, so
// it can't serve them back). This module wrote workDir in the first place,
// so it reads its own files straight off disk itself.

module.exports = { listGpuPartitions, submitJob, getJobStatus };
