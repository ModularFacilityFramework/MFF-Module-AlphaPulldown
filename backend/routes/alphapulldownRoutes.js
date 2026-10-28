// Everything this module needs from core comes through coreApi (passed into
// register() in ../index.js and down to here) - never via a relative require
// into an mff-core checkout. See docs/MFF-Core_module-core-api.md for the full contract.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { buildAf3Input, validateAf3Input } = require('../services/af3InputBuilder');
const { buildAbcfoldCommand } = require('../services/abcfoldCommandBuilder');
const { buildSbatchScript } = require('../services/sbatchTemplateBuilder');
const slurmClient = require('../services/slurmClient');

// Fixed filename the Slurm module requires inside workDir before it will
// submit a job (backend/services/slurmJobs.js's SCRIPT_FILENAME on its
// side - not this module's choice, see docs/MFF-Module-SLURM_slurm-config.md).
const SUBMIT_SCRIPT_FILENAME = 'submit.sh';
// Relative subfolder (inside workDir) the abcfold CLI itself writes its
// predicted structures into - just an argument to `abcfold`, unrelated to
// workDir's own existence, which the Slurm module already requires.
const ABCFOLD_OUTPUT_SUBDIR = 'output';
// Snapshot of the exact Run tab fields a job was (re)submitted with -
// written into workDir alongside submit.sh/the input JSON on every real
// submit attempt (see submitJobToSlurm()), purely as a plain file this
// module already owns writing into its own job folder. Lets ResultsTab.js's
// Resubmit/Clone actions restore a job's own parameters back into the Run
// tab later - deliberately NOT a database column (this module's own DB
// schema is a bigger, riskier surface to change than a file only this
// module ever reads/writes) and NOT reconstructed by parsing the AF3 input
// JSON or the abcfold command string back apart (both are one-way, lossy
// translations of these same fields - see af3InputBuilder.js/
// abcfoldCommandBuilder.js - re-deriving from them would be guesswork).
const JOB_PARAMS_FILENAME = 'job.json';
// The Run tab fields that fully describe a job, independent of any
// generated artifact (AF3 input JSON, abcfold command, sbatch script) -
// exactly what RunTab.js's own buildPayload() sends. Whitelisted (not
// req.body verbatim) so scriptContent/inputJsonFilename overrides never
// leak into the saved snapshot - job.json always reflects the job's real
// parameters, never a hand-edited script's incidental content.
const RUN_PARAM_FIELDS = [
  'name', 'sequences', 'modelSeeds', 'models', 'mmseqs2', 'templates',
  'customTemplatePath', 'ligandSmiles', 'ligandCcd', 'ligandChain',
  'modelParamsPath', 'override', 'noVisuals', 'noServer', 'gpuCount'
];
function extractRunParams(body) {
  const params = {};
  RUN_PARAM_FIELDS.forEach(field => {
    if (body[field] !== undefined) params[field] = body[field];
  });
  return params;
}

// Slurm's own standard job-state vocabulary (from `sacct`, passed through
// verbatim by slurmClient.getJobStatus() - this module invents none of
// it) that means a job is done and safe to resubmit - as opposed to still
// queued/running, where resubmitting would double-run it. Duplicated in
// frontend/components/ResultsTab.js (frontend and backend can't share a
// JS module directly in this architecture) - keep both lists in sync if
// this ever changes.
const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'DEADLINE', 'BOOT_FAIL'];

// Used whenever a user has no alphapulldown_settings row yet, so GET always
// returns something PUT can upsert without the frontend special-casing
// "no settings saved yet" vs "existing settings". default_partition/
// default_cpus_per_task/default_mem/default_time are this module's OWN
// resource request - not dependent on any admin having configured
// anything on the Slurm module's side (see resolveClusterResources()
// below for how the actual partition used gets cross-checked against
// live cluster detection). Account, email, and the output-directory base
// aren't here either, for a different reason: they come straight from
// coreApi at request time (req.user.username, coreApi.listUsers() for
// email, coreApi.getUserWorkspacePath() for the workspace path), so
// there's nothing to store in a per-user settings row for them - see
// getRequestContext() below.
const DEFAULT_SETTINGS = {
  // Matches a real, known-working reference script for this cluster
  // (njp158's pyp1_abcfold.slurm).
  slurm_mail_type: 'BEGIN,END,FAIL',
  env_manager: 'micromamba',
  env_name: 'abcfold',
  default_partition: 'gpu',
  default_cpus_per_task: 8,
  default_mem: '64G',
  default_time: '24:00:00',
  // Real local database on this cluster (uniref90/uniref30/bfd/mgnify/
  // pdb70/pdb_seqres/pdb_mmcif/uniprot/params - a full AlphaFold3 bundle) -
  // an available alternative to --mmseqs2 below, not the default: njp158's
  // own reference script proves --mmseqs2 genuinely works on this cluster
  // (a real, completed job's full output directory), so defaulting away
  // from it isn't warranted. See abcfoldCommandBuilder.js's own comment.
  default_database_dir: '/home/linuxhomes/software/genetic_db',
  // Matches njp158's reference script - real, proven working on this
  // cluster.
  default_mmseqs2: 1,
  default_templates: 0
};
const SETTINGS_FIELDS = Object.keys(DEFAULT_SETTINGS);
const ENV_MANAGERS = ['micromamba', 'conda'];

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'job';
}

// A relative path is safe to join onto workDir if every one of its segments
// is a plain name (letters/digits/./-/_ as characters, never a whole
// segment of "." or ".."). Rejects absolute paths and any path-traversal
// attempt, while still allowing one level of nesting for files the abcfold
// CLI writes into its own output/ subfolder (see ABCFOLD_OUTPUT_SUBDIR).
// The Report tab shows ABCFold's own index.html in an iframe. That page loads
// its scripts, stylesheets, plots and structure files by RELATIVE path, so the
// whole output folder has to be served under one URL prefix - fetching the
// html alone and rendering it from a blob (the first attempt) leaves every
// one of those references dangling. An iframe/new tab can't send an
// Authorization header, so access is by a short-lived ticket carried in the
// URL path (a path segment, not a query param, precisely so the relative
// references inherit it). Same idea as the Doppio module's proxy ticket.
const REPORT_ENTRY_FILE = 'index.html';
const REPORT_TICKET_IDLE_TTL_MS = 30 * 60 * 1000;
// In memory on purpose: losing them on a backend restart only means the
// Report tab mints a fresh one on its next open.
const reportTickets = new Map();

function mintReportTicket(jobId) {
  const now = Date.now();
  for (const [ticket, entry] of reportTickets) {
    if (entry.expires < now) reportTickets.delete(ticket);
  }
  const ticket = crypto.randomBytes(24).toString('hex');
  reportTickets.set(ticket, { jobId: String(jobId), expires: now + REPORT_TICKET_IDLE_TTL_MS });
  return ticket;
}

// Every validated hit slides the expiry forward, so a report left open and
// clicked around in doesn't die mid-use.
function checkReportTicket(ticket, jobId) {
  const entry = reportTickets.get(ticket);
  if (!entry || entry.jobId !== String(jobId) || entry.expires < Date.now()) return false;
  entry.expires = Date.now() + REPORT_TICKET_IDLE_TTL_MS;
  return true;
}

function isSafeRelativePath(p) {
  if (!p || path.isAbsolute(p)) return false;
  return p.split('/').every(seg => seg.length > 0 && seg !== '.' && seg !== '..' && /^[\w.-]+$/.test(seg));
}

// account: req.user.username, documented in docs/MFF-Core_module-core-api.md
// as "the current user, for that request".
// email: req.user itself has no email field, but coreApi.listUsers()
// (system-wide list, {id, username, email, ...} per entry) does - find the
// entry matching req.user.id to get the current user's own email.
// workspace: coreApi.getUserWorkspacePath(req.user) - { active, path, reason }.
// active:false (not_configured on this deployment, or forbidden - this
// user's own workspace_storage_enabled checkbox in Users & Groups is off,
// or a filesystem error) means this module has nowhere to write job output,
// so job creation and submission are both refused - see POST /jobs and
// /jobs/:id/submit below.
async function getRequestContext(coreApi, req) {
  const account = req.user.username;
  const users = await coreApi.listUsers();
  const currentUser = users.find(u => u.id === req.user.id);
  const email = currentUser ? currentUser.email : undefined;
  const workspace = await coreApi.getUserWorkspacePath(req.user);

  return { account, email, workspace };
}

// Resolves the partition + gres a job's sbatch script should request.
// partition comes from live cluster detection (slurmClient.listGpuPartitions() -
// no admin configuration needed at all, see docs/MFF-Module-SLURM_slurm-config.md:
// "Detection/stats... work without any of this"). Real detected data on
// this cluster has shown more than one partition reporting gpusPerNode > 0
// at once (e.g. both "cpu" and "gpu") - picking blindly by array order
// would risk landing on the wrong one depending on how the Slurm module
// happens to order its response, so this prefers whichever GPU-capable
// partition's name actually matches settings.default_partition, and only
// falls back to array order if no name match exists. If detection comes
// back with no GPU-capable partition at all (the call failed, or this
// cluster genuinely has none), this falls through to
// settings.default_partition as a plain string - this module owns a real
// resource request outright, it doesn't have to wait on Slurm-side data
// to produce a submittable script. gres is never looked up, always
// computed directly from the GPU count the user actually asked for.
// slurmError/slurmErrorStatus/slurmErrorMessage: partitionsResult's own
// status/error straight through - status 403 means this specific user
// isn't a registered Slurm user at all (docs/MFF-Module-SLURM_slurm-config.md's
// "Access gate"), a real per-user rejection, distinct from every other
// non-2xx/network failure ("unreachable"). Only affects the live
// partitions list and the partition pick's accuracy - it never blocks
// job creation, since default_partition always provides a real value.
async function resolveClusterResources(coreApi, req, settings, gpuCount) {
  const partitionsResult = await slurmClient.listGpuPartitions(coreApi, req.headers.authorization);
  // Array.isArray guard: slurmClient.js hard-codes [] on a failed call, but
  // a "successful" (2xx) response with an unexpected body shape from the
  // Slurm module is still possible - without this guard that shape would
  // throw straight out of the .filter() below.
  const partitions = Array.isArray(partitionsResult.data) ? partitionsResult.data : [];
  const slurmError = partitionsResult.status === 403 ? 'no_slurm_access' : (partitionsResult.error ? 'unreachable' : null);
  const slurmErrorStatus = partitionsResult.status;
  const slurmErrorMessage = partitionsResult.error;

  const gpuPartitions = partitions.filter(p => p.gpusPerNode > 0);
  const preferredMatch = gpuPartitions.find(p => p.name === settings.default_partition);
  const chosenPartition = preferredMatch || gpuPartitions[0];
  const partition = chosenPartition ? chosenPartition.name : settings.default_partition;
  const gres = `gpu:${gpuCount}`;

  return { partitions, partition, gres, slurmError, slurmErrorStatus, slurmErrorMessage };
}

// Shared by GET, PUT, and POST /settings/preview - normalizes an arbitrary
// request body into a full settings object (every field either the caller's
// own value or DEFAULT_SETTINGS' fallback), the same way PUT's own upsert
// values do. Pulled out so POST /settings/preview can reuse it without
// duplicating PUT's validation.
function normalizeSettings(body) {
  const values = {};
  for (const field of SETTINGS_FIELDS) {
    values[field] = body[field] !== undefined ? body[field] : DEFAULT_SETTINGS[field];
  }
  if (!ENV_MANAGERS.includes(values.env_manager)) values.env_manager = DEFAULT_SETTINGS.env_manager;
  return values;
}

// Shared by GET and PUT /settings - the settings row plus everything the
// Setup tab needs to show read-only (account/email/workspace/cluster
// resources) and a preview of the sbatch script those settings would
// currently produce.
async function buildSettingsResponse(coreApi, req, settings) {
  const { account, email, workspace } = await getRequestContext(coreApi, req);
  const { partitions, partition, gres, slurmError, slurmErrorStatus, slurmErrorMessage } =
    await resolveClusterResources(coreApi, req, settings, 1);

  const previewSlug = 'preview';
  const previewCommand = buildAbcfoldCommand({
    inputJsonFilename: `${previewSlug}.input.json`,
    outputDir: ABCFOLD_OUTPUT_SUBDIR,
    models: ['alphafold3'],
    mmseqs2: !!settings.default_mmseqs2,
    databaseDir: settings.default_database_dir,
    templates: !!settings.default_templates,
    noServer: true
  });
  const sbatchPreview = buildSbatchScript({
    slug: previewSlug,
    settings,
    abcfoldCommand: previewCommand,
    outputDir: ABCFOLD_OUTPUT_SUBDIR,
    email,
    resources: { partition, gres, cpusPerTask: settings.default_cpus_per_task, mem: settings.default_mem, time: settings.default_time }
  });

  return {
    ...settings, account, email,
    slurmError, slurmErrorStatus, slurmErrorMessage,
    workspace, partitions, sbatchPreview
  };
}

// Shared by POST /jobs, POST /jobs/preview, and POST /jobs/:id/submit -
// validates a job-definition request body and, if valid, builds the AF3
// input JSON, abcfold command, and sbatch script text those fields would
// produce. Never touches the database beyond a read (settings lookup) and
// never touches the filesystem - callers decide what to do with the
// result. Returns { error: { status, body } } on any validation failure
// (matching an Express handler's own res.status(status).json(body) shape,
// so callers can just forward it), or the generated artifacts with
// error: null. `body || {}`: a request with no JSON body at all (wrong/
// missing Content-Type, or a caller that posts with nothing) leaves
// req.body undefined rather than {} - fall through to the normal "name is
// required" validation error instead of throwing on the destructure below.
async function buildJobArtifacts(coreApi, req, conn, body) {
  const {
    name, sequences, modelSeeds, models,
    mmseqs2, templates, customTemplatePath,
    ligandSmiles, ligandCcd, ligandChain,
    modelParamsPath, override, noVisuals, noServer,
    gpuCount
  } = body || {};

  if (!name || !name.trim()) return { error: { status: 400, body: { error: 'name is required' } } };
  if (!Array.isArray(sequences) || sequences.length === 0) {
    return { error: { status: 400, body: { error: 'at least one sequence entry is required' } } };
  }
  if (!Array.isArray(models) || models.length === 0) {
    return { error: { status: 400, body: { error: 'at least one model must be selected' } } };
  }
  const requestedGpuCount = Number.isInteger(gpuCount) && gpuCount > 0 ? gpuCount : 1;

  const { email, workspace } = await getRequestContext(coreApi, req);
  if (!workspace.active) {
    return { error: { status: 503, body: { error: 'Workspace storage is not available for this user.' } } };
  }

  const settingsRows = await conn.query('SELECT * FROM alphapulldown_settings WHERE owner_id = ?', [req.user.id]);
  const settings = settingsRows[0] || DEFAULT_SETTINGS;
  const { partition, gres } = await resolveClusterResources(coreApi, req, settings, requestedGpuCount);

  const seeds = (modelSeeds && modelSeeds.length > 0) ? modelSeeds : [1];
  const af3Input = buildAf3Input({ name, sequences, modelSeeds: seeds });
  const inputErrors = validateAf3Input(af3Input);
  if (inputErrors.length > 0) {
    return { error: { status: 400, body: { error: 'Invalid job input', details: inputErrors } } };
  }

  const slug = `${slugify(name)}-${Date.now()}`;
  const inputJsonFilename = `${slug}.input.json`;

  const abcfoldCommand = buildAbcfoldCommand({
    inputJsonFilename,
    outputDir: ABCFOLD_OUTPUT_SUBDIR,
    models,
    mmseqs2: mmseqs2 !== undefined ? !!mmseqs2 : !!settings.default_mmseqs2,
    databaseDir: settings.default_database_dir,
    templates: templates !== undefined ? !!templates : !!settings.default_templates,
    customTemplatePath,
    ligandSmiles,
    ligandCcd,
    ligandChain,
    modelParamsPath,
    override: !!override,
    noVisuals: !!noVisuals,
    noServer: noServer !== undefined ? !!noServer : true
  });

  const sbatchScript = buildSbatchScript({
    slug, settings, abcfoldCommand, outputDir: ABCFOLD_OUTPUT_SUBDIR, email,
    resources: { partition, gres, cpusPerTask: settings.default_cpus_per_task, mem: settings.default_mem, time: settings.default_time }
  });

  return { error: null, name, models, workspace, inputJsonFilename, af3Input, abcfoldCommand, sbatchScript };
}

// Shared by POST /jobs (the one automatic attempt right after creation) and
// POST /jobs/:id/submit (resubmit, reusing the same job's own workDir) -
// writes this job's submit.sh + input JSON + job.json onto disk at its own
// workDir (job.output_dir), then hands workDir to the Slurm module for real
// submission. job.sbatch_script/job.input_json are whatever the caller
// already resolved (and saved to the row) before calling this - a plain
// create writes freshly generated ones, a resubmit writes freshly
// regenerated ones from the (possibly edited) Run tab fields it was called
// with. The Slurm module never touches the filesystem itself
// (docs/MFF-Module-SLURM_slurm-config.md) - workDir must already exist
// with those files in place before it's called, so that's this module's
// job, not core's or the Slurm module's.
async function submitJobToSlurm(coreApi, req, conn, job, runParams) {
  const workspace = await coreApi.getUserWorkspacePath(req.user);
  if (!workspace.active) {
    return { success: false, status: 503, error: 'Workspace storage is not available for this user.' };
  }

  try {
    // A resubmit reuses this same job's workDir - wipe it clean first, so
    // nothing an earlier attempt left behind (old slurm.out/err, the
    // abcfold CLI's own output/ subfolder, an old job.json) survives into
    // this attempt. Safe on a brand-new job too: removing a path that
    // doesn't exist yet is a no-op with force:true.
    await fs.rm(job.output_dir, { recursive: true, force: true });
    await fs.mkdir(job.output_dir, { recursive: true });
    await fs.writeFile(path.join(job.output_dir, SUBMIT_SCRIPT_FILENAME), job.sbatch_script, 'utf8');
    await fs.writeFile(path.join(job.output_dir, job.input_json_filename), job.input_json, 'utf8');
    await fs.writeFile(path.join(job.output_dir, JOB_PARAMS_FILENAME), JSON.stringify(runParams, null, 2), 'utf8');
  } catch (fsErr) {
    return { success: false, status: 502, error: fsErr.message };
  }

  const result = await slurmClient.submitJob(coreApi, req.headers.authorization, {
    workDir: job.output_dir,
    jobName: job.name
  });
  if (!result.success) {
    return { success: false, status: result.status || 502, error: result.error };
  }

  await conn.query('UPDATE alphapulldown_jobs SET status = ?, slurm_job_id = ? WHERE id = ?', ['SUBMITTED', result.jobId, job.id]);
  const updated = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ?', [job.id]);
  return { success: true, job: updated[0] };
}

module.exports = function buildRouter(coreApi) {
  const router = express.Router();

  // GET /api/alphapulldown/settings - the caller's own sbatch/AlphaPulldown defaults,
  // plus read-only account/email/cluster-resource info and a script preview.
  router.get('/settings', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const rows = await conn.query('SELECT * FROM alphapulldown_settings WHERE owner_id = ?', [req.user.id]);
      const settings = rows[0] || { ...DEFAULT_SETTINGS, owner_id: req.user.id };
      res.json(await buildSettingsResponse(coreApi, req, settings));
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch settings', message: err.message });
    } finally {
      conn.release();
    }
  });

  // PUT /api/alphapulldown/settings - upsert on owner_id
  router.put('/settings', coreApi.authenticateToken, async (req, res) => {
    const values = normalizeSettings(req.body);

    const conn = await coreApi.pool.getConnection();
    try {
      const columns = ['owner_id', ...SETTINGS_FIELDS];
      const placeholders = columns.map(() => '?').join(', ');
      const updateClause = SETTINGS_FIELDS.map(f => `${f} = VALUES(${f})`).join(', ');
      await conn.query(
        `INSERT INTO alphapulldown_settings (${columns.join(', ')}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateClause}`,
        [req.user.id, ...SETTINGS_FIELDS.map(f => values[f])]
      );
      const rows = await conn.query('SELECT * FROM alphapulldown_settings WHERE owner_id = ?', [req.user.id]);
      res.json(await buildSettingsResponse(coreApi, req, rows[0]));
    } catch (err) {
      res.status(500).json({ error: 'Failed to save settings', message: err.message });
    } finally {
      conn.release();
    }
  });

  // POST /api/alphapulldown/settings/preview - regenerates the sbatch preview from
  // whatever's currently in the Setup tab's form, without saving anything.
  // Lets the preview update live as the user edits fields, instead of only
  // refreshing after a real Save.
  router.post('/settings/preview', coreApi.authenticateToken, async (req, res) => {
    try {
      res.json(await buildSettingsResponse(coreApi, req, normalizeSettings(req.body)));
    } catch (err) {
      res.status(500).json({ error: 'Failed to build preview', message: err.message });
    }
  });

  // GET /api/alphapulldown/jobs - the caller's own job drafts, list view
  router.get('/jobs', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const rows = await conn.query(
        'SELECT id, job_number, name, status, models_selected, created_at FROM alphapulldown_jobs WHERE owner_id = ? ORDER BY created_at DESC',
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch jobs', message: err.message });
    } finally {
      conn.release();
    }
  });

  // GET /api/alphapulldown/jobs/:id - full draft, ownership check baked into the
  // WHERE clause so this never reveals whether another user's job exists.
  router.get('/jobs/:id', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const rows = await conn.query(
        'SELECT * FROM alphapulldown_jobs WHERE id = ? AND owner_id = ?',
        [req.params.id, req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch job', message: err.message });
    } finally {
      conn.release();
    }
  });

  // POST /api/alphapulldown/jobs/preview - same validation and generation as
  // POST /jobs, but touches neither the database nor the filesystem. Lets
  // the Run tab show (and let the user edit) a real sbatch script before
  // ever creating a job, the same live-preview pattern already used by
  // POST /settings/preview on the Setup tab.
  router.post('/jobs/preview', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const artifacts = await buildJobArtifacts(coreApi, req, conn, req.body);
      if (artifacts.error) return res.status(artifacts.error.status).json(artifacts.error.body);
      res.json({
        inputJson: JSON.stringify(artifacts.af3Input, null, 2),
        abcfoldCommand: artifacts.abcfoldCommand,
        sbatchScript: artifacts.sbatchScript,
        // The Run tab must send this back unchanged alongside scriptContent
        // at create time - see POST /jobs's own comment for why (the
        // filename baked into this preview's sbatchScript/abcfoldCommand
        // text has to match the filename the input JSON actually gets
        // written under, and a second, independent buildJobArtifacts() call
        // at create time would otherwise mint a different one).
        inputJsonFilename: artifacts.inputJsonFilename
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to build preview', message: err.message });
    } finally {
      conn.release();
    }
  });

  // POST /api/alphapulldown/jobs - generates the AF3 input JSON, abcfold command,
  // and sbatch script, persists them, and immediately submits to Slurm in
  // the same request - no separate draft-review step. req.body.scriptContent,
  // if present, is stored and used exactly as given (the Run tab's preview
  // box, edited or not - there is no "was it edited" distinction anywhere
  // in this module, whatever's in that box is what runs); otherwise the
  // freshly generated script is used. If the submit step fails (workspace
  // gone, fs error, Slurm unreachable), the job row still exists with
  // status='draft' - that status now only ever means "created but failed
  // to submit", never an intentional pause - and the response includes it
  // so the caller can route straight to it. POST /jobs/:id/submit is the
  // resubmit path for exactly that case.
  router.post('/jobs', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const artifacts = await buildJobArtifacts(coreApi, req, conn, req.body);
      if (artifacts.error) return res.status(artifacts.error.status).json(artifacts.error.body);
      const { name, models, workspace, af3Input, abcfoldCommand, sbatchScript } = artifacts;

      const scriptContent = (typeof req.body.scriptContent === 'string' && req.body.scriptContent.trim())
        ? req.body.scriptContent
        : sbatchScript;
      // buildJobArtifacts() above mints its own fresh inputJsonFilename
      // (name-Date.now()-based) on every call, independent of any earlier
      // call the Run tab already made via POST /jobs/preview. When the
      // client sends back scriptContent from that earlier preview, the
      // filename actually referenced inside its abcfoldCommand line is
      // whatever preview call minted - NOT artifacts.inputJsonFilename from
      // this request's own, separate call. Using the fresh one here while
      // storing the stale scriptContent verbatim silently writes the input
      // JSON under a name the stored script never asks for, so the job
      // fails on the cluster with "Input file does not exist". The Run tab
      // threads its preview's inputJsonFilename back through alongside
      // scriptContent for exactly this reason - honor it whenever both are
      // present and they travel together; only fall back to this request's
      // own freshly generated name when no scriptContent override is in
      // play (or a non-UI caller sent scriptContent with no filename to
      // match it, which is no worse than before this fix).
      const inputJsonFilename = (scriptContent === sbatchScript || typeof req.body.inputJsonFilename !== 'string' || !req.body.inputJsonFilename.trim())
        ? artifacts.inputJsonFilename
        : req.body.inputJsonFilename;

      // Per-owner sequential number (1, 2, 3, ...), not the row's own global
      // id - shown to the user as "J<jobNumber>" and used to name this job's
      // own workDir, under this module's own subfolder of the user's core
      // workspace (workspace.path is just the user's raw core-provisioned
      // directory - core has no notion of "module-AlphaPulldown" inside it).
      const numberRows = await conn.query(
        'SELECT COALESCE(MAX(job_number), 0) + 1 AS nextNumber FROM alphapulldown_jobs WHERE owner_id = ?',
        [req.user.id]
      );
      const jobNumber = numberRows[0].nextNumber;
      // workDir: the real, absolute directory this job's submit.sh + input
      // JSON get written into (see submitJobToSlurm()), and what gets
      // handed to the Slurm module as workDir - it must already exist with
      // those files in place before that module will touch it
      // (docs/MFF-Module-SLURM_slurm-config.md).
      const workDir = `${workspace.path}/module-AlphaPulldown/J${jobNumber}`.replace(/\/+/g, '/');

      const result = await conn.query(
        `INSERT INTO alphapulldown_jobs
          (owner_id, job_number, name, status, models_selected, output_dir, input_json_filename, input_json, abcfold_command, sbatch_script)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [req.user.id, jobNumber, name, models.join(','), workDir, inputJsonFilename, JSON.stringify(af3Input, null, 2), abcfoldCommand, scriptContent]
      );
      const rows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ?', [result.insertId]);
      const job = rows[0];

      const submitResult = await submitJobToSlurm(coreApi, req, conn, job, extractRunParams(req.body));
      if (!submitResult.success) {
        return res.status(submitResult.status).json({
          error: 'Job created but failed to submit to Slurm', message: submitResult.error, job
        });
      }
      res.status(201).json(submitResult.job);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create job', message: err.message });
    } finally {
      conn.release();
    }
  });

  // POST /api/alphapulldown/jobs/:id/submit - resubmit path, for either a job
  // stuck in status='draft' (POST /jobs's own automatic submit attempt
  // failed - workspace gone, fs error, Slurm unreachable) or a job that
  // already reached Slurm and finished (TERMINAL_STATES below - failed,
  // was cancelled, or even completed successfully and someone wants to
  // run it again). Unlike the original create-only flow, this now takes a
  // full body (same shape as POST /jobs's) and regenerates everything from
  // it via buildJobArtifacts() - the Run tab always routes a resubmit
  // through itself first (pre-filled from this job's own job.json, see
  // GET /jobs/:id/download?file=job.json), so someone gets a real chance to
  // edit sequences/models/settings before it runs again, not just a blind
  // rerun of whatever was stored at creation time. Reuses this same job's
  // row and workDir (job_number/output_dir are never reassigned - a
  // resubmit is still "this job, again", not a new one; see submitJobToSlurm
  // for the workDir-cleaning step that makes reusing it safe) - creating an
  // actually-new job from the same starting parameters is what "Clone" in
  // ResultsTab.js is for instead, via the ordinary POST /jobs. 409s only
  // while a job is genuinely still in flight (has a slurm_job_id AND its
  // cached status isn't terminal yet) - resubmitting that would double-run
  // it; a stale tab / double click on an in-flight job still can't submit
  // it twice.
  router.post('/jobs/:id/submit', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const jobRows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
      if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const existingJob = jobRows[0];
      if (existingJob.slurm_job_id && !TERMINAL_STATES.includes(existingJob.status)) {
        return res.status(409).json({ error: 'Job is still in progress' });
      }

      const artifacts = await buildJobArtifacts(coreApi, req, conn, req.body);
      if (artifacts.error) return res.status(artifacts.error.status).json(artifacts.error.body);
      const { name, models, af3Input, abcfoldCommand, sbatchScript } = artifacts;

      const scriptContent = (typeof req.body.scriptContent === 'string' && req.body.scriptContent.trim())
        ? req.body.scriptContent
        : sbatchScript;
      // Same reasoning as POST /jobs: when scriptContent is a preview the
      // Run tab generated earlier, the input filename actually referenced
      // inside it is whatever that earlier preview minted, not this
      // request's own fresh one - honor the filename the Run tab threads
      // back through req.body.inputJsonFilename so the two never disagree.
      const inputJsonFilename = (scriptContent === sbatchScript || typeof req.body.inputJsonFilename !== 'string' || !req.body.inputJsonFilename.trim())
        ? artifacts.inputJsonFilename
        : req.body.inputJsonFilename;

      await conn.query(
        `UPDATE alphapulldown_jobs
          SET name = ?, status = 'draft', slurm_job_id = NULL, models_selected = ?,
              input_json_filename = ?, input_json = ?, abcfold_command = ?, sbatch_script = ?
         WHERE id = ?`,
        [name, models.join(','), inputJsonFilename, JSON.stringify(af3Input, null, 2), abcfoldCommand, scriptContent, existingJob.id]
      );
      const rows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ?', [existingJob.id]);
      const job = rows[0];

      const submitResult = await submitJobToSlurm(coreApi, req, conn, job, extractRunParams(req.body));
      if (!submitResult.success) {
        return res.status(submitResult.status).json({ error: 'Failed to submit job', message: submitResult.error, job });
      }
      res.json(submitResult.job);
    } catch (err) {
      res.status(500).json({ error: 'Failed to submit job', message: err.message });
    } finally {
      conn.release();
    }
  });

  // DELETE /api/alphapulldown/jobs/:id - removes a job's own folder and its DB
  // row. Same ownership + in-flight guard as POST /jobs/:id/submit above -
  // can't delete something still running on the cluster (409), but a
  // 'draft' job (never reached Slurm, or failed to submit) is freely
  // deletable, same as it's freely resubmittable. Filesystem before database,
  // deliberately: if fs.rm throws, the row is left intact so Delete can be
  // retried - the alternative (DB row gone, folder still on disk) would be
  // an orphaned folder nothing in this module can ever list or reach again.
  router.delete('/jobs/:id', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const jobRows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
      if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = jobRows[0];
      if (job.slurm_job_id && !TERMINAL_STATES.includes(job.status)) {
        return res.status(409).json({ error: 'Job is still in progress' });
      }

      try {
        await fs.rm(job.output_dir, { recursive: true, force: true });
      } catch (fsErr) {
        return res.status(502).json({ error: 'Failed to delete job folder', message: fsErr.message });
      }
      await conn.query('DELETE FROM alphapulldown_jobs WHERE id = ?', [job.id]);
      res.status(200).json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete job', message: err.message });
    } finally {
      conn.release();
    }
  });

  // GET /api/alphapulldown/jobs/:id/status - live status from the Slurm module
  // (slurmClient.getJobStatus()), and refreshes this job's cached status
  // column so the list view stays reasonably fresh without polling Slurm
  // for every job every time.
  router.get('/jobs/:id/status', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const jobRows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
      if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = jobRows[0];
      if (!job.slurm_job_id) return res.status(400).json({ error: 'Job has not been submitted yet' });

      const result = await slurmClient.getJobStatus(coreApi, req.headers.authorization, job.slurm_job_id);
      if (!result.success) {
        return res.status(result.status || 502).json({ error: 'Failed to fetch job status', message: result.error });
      }

      await conn.query('UPDATE alphapulldown_jobs SET status = ? WHERE id = ?', [result.state, job.id]);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch job status', message: err.message });
    } finally {
      conn.release();
    }
  });

  // GET /api/alphapulldown/jobs/:id/files - filenames currently in the job's own
  // workDir (job.output_dir), read straight off disk. The Slurm module
  // provides no file-listing route at all anymore - it never reads workDir,
  // so it can't serve its contents back (docs/MFF-Module-SLURM_slurm-config.md).
  // This module wrote workDir in the first place (POST /jobs/:id/submit),
  // so it's the one that reads it back. Recurses one level of subfolders
  // (the abcfold CLI's own output/ subfolder in particular) so predicted
  // structures show up alongside submit.sh/slurm.out/slurm.err, not just
  // the top-level entries. Not gated on job.slurm_job_id: submitJobToSlurm()
  // writes submit.sh/the input JSON/job.json before it ever calls the Slurm
  // module, so a job stuck in status='draft' because that later call
  // failed can still have real files on disk (job.json in particular -
  // ResultsTab.js's Resubmit/Clone need to read it for exactly that job).
  // fs.readdir's own ENOENT handling below already covers the case where
  // nothing was written at all.
  router.get('/jobs/:id/files', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const jobRows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
      if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = jobRows[0];

      try {
        const entries = await fs.readdir(job.output_dir, { recursive: true });
        const filenames = [];
        for (const entry of entries) {
          const stat = await fs.stat(path.join(job.output_dir, entry));
          if (stat.isFile()) filenames.push(entry);
        }
        res.json(filenames);
      } catch (fsErr) {
        if (fsErr.code === 'ENOENT') return res.json([]);
        throw fsErr;
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to list job files', message: err.message });
    } finally {
      conn.release();
    }
  });

  // GET /api/alphapulldown/jobs/:id/download?file=<relative path> - hands back
  // one file's raw content, read straight off disk from job.output_dir
  // (see GET /jobs/:id/files above - same reasoning, the Slurm module
  // provides no download route either, and the same not-gated-on-
  // slurm_job_id reasoning - a 'draft' job's own job.json must stay
  // readable). A query param, not a URL path segment, because `file` can
  // include a subfolder (e.g. "output/model.cif") and Express 5's own
  // path-segment wildcard syntax isn't worth fighting for this.
  // isSafeRelativePath() rejects anything but a plain relative path, and
  // the resolved path is double-checked to still be inside output_dir
  // before reading, guarding against path traversal and Content-Disposition
  // header injection.
  router.get('/jobs/:id/download', coreApi.authenticateToken, async (req, res) => {
    const file = req.query.file;
    if (typeof file !== 'string' || !isSafeRelativePath(file)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const conn = await coreApi.pool.getConnection();
    try {
      const jobRows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
      if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = jobRows[0];

      const resolvedDir = path.resolve(job.output_dir);
      const resolvedFile = path.resolve(job.output_dir, file);
      if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(resolvedDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      let content;
      try {
        content = await fs.readFile(resolvedFile);
      } catch (fsErr) {
        return res.status(404).json({ error: 'File not found', message: fsErr.message });
      }

      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
      res.send(content);
    } catch (err) {
      res.status(500).json({ error: 'Failed to download job file', message: err.message });
    } finally {
      conn.release();
    }
  });

  // POST /api/alphapulldown/jobs/:id/report-ticket - mints the ticket the Report
  // tab's iframe URL carries. 404 when the job's folder has no index.html
  // (ABCFold writes it only with visualizations on), so the tab can say so.
  router.post('/jobs/:id/report-ticket', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const jobRows = await conn.query('SELECT * FROM alphapulldown_jobs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
      if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = jobRows[0];

      try {
        const stat = await fs.stat(path.join(job.output_dir, REPORT_ENTRY_FILE));
        if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      } catch (fsErr) {
        if (fsErr.code === 'ENOENT') return res.status(404).json({ error: 'No report for this job' });
        throw fsErr;
      }
      res.json({ ticket: mintReportTicket(job.id), entry: REPORT_ENTRY_FILE });
    } catch (err) {
      res.status(500).json({ error: 'Failed to open report', message: err.message });
    } finally {
      conn.release();
    }
  });

  // GET /api/alphapulldown/jobs/:id/report/:ticket/<any path inside output_dir> -
  // the job's output folder as a static site, for the Report iframe. No
  // authenticateToken: the ticket is the credential (see above). Read-only,
  // and confined to output_dir (lexically and after resolving symlinks).
  // Deliberately no CSP `sandbox` header: it gives the report an opaque
  // origin, and tried in a real browser pane that blocked every script and
  // stylesheet request the page makes.
  router.get('/jobs/:id/report/:ticket/*splat', async (req, res) => {
    if (!checkReportTicket(req.params.ticket, req.params.id)) {
      return res.status(401).json({ error: 'Report link expired - reopen the Report tab' });
    }
    const segments = [].concat(req.params.splat);
    if (segments.length === 0 || segments.some(seg => !seg || seg === '.' || seg === '..' || seg.includes('\0') || seg.includes('\\'))) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const conn = await coreApi.pool.getConnection();
    try {
      const jobRows = await conn.query('SELECT output_dir FROM alphapulldown_jobs WHERE id = ?', [req.params.id]);
      if (jobRows.length === 0) return res.status(404).json({ error: 'Job not found' });

      let realDir;
      let realFile;
      try {
        realDir = await fs.realpath(jobRows[0].output_dir);
        realFile = await fs.realpath(path.join(realDir, ...segments));
      } catch (fsErr) {
        return res.status(404).json({ error: 'File not found' });
      }
      if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      res.setHeader('Cache-Control', 'no-store');
      // dotfiles: ABCFold's own assets live in ".feature_viewer" and ".plots".
      res.sendFile(realFile, { dotfiles: 'allow' }, sendErr => {
        if (sendErr && !res.headersSent) res.status(sendErr.status || 404).json({ error: 'File not found' });
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read report file', message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};
