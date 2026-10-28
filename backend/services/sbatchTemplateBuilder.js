// Builds the sbatch script text for a job draft. abcfoldRoutes.js's POST
// /jobs/:id/submit writes this text to disk itself, as workDir/submit.sh -
// the Slurm module requires workDir to already exist with that exact
// script (and any input files) in place before it will submit it
// (docs/MFF-Module-SLURM_slurm-config.md); it never touches the filesystem
// itself. sbatch runs the job with workDir as its cwd (`sbatch --chdir`),
// so this script's own relative paths (input JSON, outputDir) resolve
// against workDir with no absolute paths needed.

// ABCFold is single-GPU, single-node by its own fixed nature - never
// requested from anywhere, never user-configurable. `resources` (partition/
// gres/cpusPerTask/mem/time - see buildSbatchScript's own params) is NOT a
// constant like this: partition comes from live cluster detection, the
// rest are this module's own configured defaults, both resolved by the
// caller (backend/routes/abcfoldRoutes.js's resolveClusterResources())
// before this function ever runs - this file just writes out whatever it's
// handed.
const NODES = 1;
const NTASKS = 1;

function buildSbatchScript({ slug, settings, abcfoldCommand, outputDir, email, resources }) {
  const lines = [
    // -i (interactive): needed for the micromamba/conda shell hook below to
    // actually define the `micromamba`/`conda` shell function - non-interactive
    // bash skips that setup, so a later `micromamba activate ...` would fail
    // with "command not found" without this. njp158's own known-working
    // reference script (pyp1_abcfold.slurm) instead does
    // `source /home/linuxhomes/software/xtal64` with a plain (non -i)
    // shebang - -i covers the same need directly, so both together would be
    // redundant; deliberately not adding the xtal64 source line on top of
    // this.
    '#!/bin/bash -i',
    // sbatch splits #SBATCH directive values on whitespace, so the raw job
    // name (which may contain spaces) can't be used here - slug is already
    // sanitized to a single dash-separated token.
    `#SBATCH --job-name=${slug}`,
    // No --account here - confirmed live via sacctmgr on this cluster that
    // this module's own core login username is a Slurm USER, not a Slurm
    // ACCOUNT (e.g. user "namlb" belongs to account "nusbf" - the two are
    // different values in Slurm's own accounting model, see
    // `sacctmgr show assoc`). Which real person a job is attributed to is
    // however the Slurm module itself invokes `sbatch` on the calling
    // user's behalf - not something this generated script can or should
    // declare via a directive.
    `#SBATCH --nodes=${NODES}`,
    `#SBATCH --ntasks=${NTASKS}`,
    // partition/gres: partition comes from live cluster detection
    // (backend/services/slurmClient.js's listGpuPartitions(), no admin
    // config needed - falls back to settings.default_partition only if
    // that detection itself came back empty), gres is computed directly
    // from the requested GPU count. cpus-per-task/mem/time are this
    // module's own configured resource request (Setup tab), not looked
    // up from anywhere - see backend/routes/abcfoldRoutes.js's
    // resolveClusterResources().
    `#SBATCH --partition=${resources.partition}`,
    `#SBATCH --gres=${resources.gres}`,
    `#SBATCH --cpus-per-task=${resources.cpusPerTask}`,
    `#SBATCH --mem=${resources.mem}`,
    `#SBATCH --time=${resources.time}`,
    // Relative paths - workDir is already this job's cwd (see file header
    // comment). The Slurm module's own submission always passes explicit
    // --output/--error to sbatch itself, which takes precedence over
    // these every time a job runs through this module's normal flow
    // (docs/MFF-Module-SLURM_slurm-config.md) - included anyway so this
    // script stays correct and self-documenting if it's ever copied out
    // and run directly with a plain `sbatch submit.sh`.
    '#SBATCH --output=slurm.out',
    '#SBATCH --error=slurm.err'
  ];

  if (email) {
    lines.push(`#SBATCH --mail-user=${email}`);
    if (settings.slurm_mail_type) lines.push(`#SBATCH --mail-type=${settings.slurm_mail_type}`);
  } else {
    lines.push('# --mail-user omitted - no email on record for this core account');
    lines.push('# (coreApi.listUsers() has no email value for this user).');
  }

  // env_manager is either 'micromamba' or 'conda' (validated/defaulted in
  // abcfoldRoutes.js's PUT /settings); the two have different shell-hook
  // activation syntax.
  const activationLines = settings.env_manager === 'conda'
    ? ['eval "$(conda shell.bash hook)"', `conda activate ${settings.env_name}`]
    : ['eval "$(micromamba shell hook --shell bash)"', `micromamba activate ${settings.env_name}`];

  lines.push(
    '',
    'set -euo pipefail',
    '',
    `mkdir -p "${outputDir}"`,
    '',
    ...activationLines,
    '',
    // GPU/framework setup - matches njp158's newest known-working script
    // (clipper_abcfold.slurm) in behaviour and order, not optional or
    // configurable: MIG slices need CUDA_VISIBLE_DEVICES set to the MIG UUID
    // (harmless on non-MIG nodes), Protenix needs LAYERNORM_TYPE=torch, and
    // JAX/XLA needs the custom-kernel-fusion workaround on this cluster's
    // GPUs. Adapted only for this script's `set -euo pipefail` (njp158's has
    // neither -u nor pipefail): ${CUDA_VISIBLE_DEVICES:-} because a bare
    // reference aborts the job under -u when it's unset, and the nvidia-smi
    // output is captured before grepping because `nvidia-smi -L | grep -q`
    // can falsely fail under pipefail (grep -q exits early -> SIGPIPE).
    'GPU_LIST=$(nvidia-smi -L || true)',
    'if grep -q "MIG-" <<< "$GPU_LIST"; then',
    '  export CUDA_VISIBLE_DEVICES=$(grep -o "MIG-[0-9a-f-]*" <<< "$GPU_LIST" | head -1)',
    'fi',
    // Shell parameter expansion, not a JS template - single-quoted on purpose.
    // eslint-disable-next-line no-template-curly-in-string
    'echo "CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-}"',
    '',
    'export LAYERNORM_TYPE=torch',
    'export XLA_FLAGS="--xla_disable_hlo_passes=custom-kernel-fusion-rewriter"',
    '',
    '# Input JSON referenced by relative filename - place it alongside this',
    '# script before submitting (see file header comment).',
    abcfoldCommand,
    ''
  );

  return lines.join('\n');
}

module.exports = { buildSbatchScript };
