// Thin wrapper around coreApi.callModule() for the ABCFold module, the same
// way slurmClient.js wraps the Slurm module. Core stays generic (there is no
// coreApi.abcfold); naming and interpreting ABCFold's API is this module's job.
//
// Every function takes the CALLING USER's own token and coreApi. callModule
// never throws - failures come back as { ok: false, status, error } - so
// nothing here needs a try/catch, it checks r.ok.
//
// THE CONTRACT BELOW IS ASSUMED, NOT DOCUMENTED. The ABCFold module has no
// written cross-module API yet (requests/A2); this is the shape of its own UI
// routes as this module's scaffold knew them. It is the only file that knows
// it, so when A2 lands this is the one place to check and change.
//
//   POST /jobs   { name, sequences: [{ type: 'protein', id, sequence,
//                  unpairedMsaPath? }], modelSeeds: [1..n], models: ['alphafold3'],
//                  templates, gpuCount, mmseqs2? }
//                -> 201 { id, status, slurm_job_id, ... }  (creates AND submits)
//   GET  /jobs/:id/status
//                -> { state, submittedAt, startedAt, endedAt, ... }  (Slurm's own words)
//
// unpairedMsaPath is only honoured once request A1 is done; before that the
// ABCFold module ignores it and searches for its own MSAs.

const CREATE_TIMEOUT_MS = 60000;

// ABCFold answers with its own job row; the Slurm job id may be missing, in
// which case the pair can be followed but not cancelled from here.
async function createJob(coreApi, token, body) {
  const r = await coreApi.callModule(token, 'abcfold', 'POST', '/jobs', { body, timeoutMs: CREATE_TIMEOUT_MS });
  if (!r.ok) return { success: false, error: r.error || `ABCFold answered ${r.status}`, status: r.status };
  const data = r.data || {};
  const jobId = data.id !== undefined ? data.id : data.jobId;
  if (jobId === undefined || jobId === null) return { success: false, error: 'The ABCFold module answered without a job id.', status: 502 };
  const slurmJobId = data.slurm_job_id !== undefined ? data.slurm_job_id : data.slurmJobId;
  return {
    success: true,
    jobId: String(jobId),
    slurmJobId: slurmJobId === undefined || slurmJobId === null ? null : String(slurmJobId),
    state: typeof data.status === 'string' && data.status ? data.status : (typeof data.state === 'string' ? data.state : null)
  };
}

async function getJobStatus(coreApi, token, jobId) {
  const r = await coreApi.callModule(token, 'abcfold', 'GET', `/jobs/${encodeURIComponent(jobId)}/status`);
  if (!r.ok) return { success: false, error: r.error || `ABCFold answered ${r.status}`, status: r.status };
  return { success: true, ...(r.data || {}) };
}

module.exports = { createJob, getJobStatus };
