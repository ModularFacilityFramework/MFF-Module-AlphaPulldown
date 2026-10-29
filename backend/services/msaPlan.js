// What one MSA run is: which proteins, what the job asks Slurm for, and the
// two scripts that do the work. Pure functions - no database, no disk, no
// Slurm - so they are unit-tested without a running mff-core.
//
// One run is ONE Slurm job. Its script runs AlphaPulldown's
// create_individual_features.py once per protein, `parallel` proteins at a
// time (xargs -P), inside a single allocation sized for that many. A Slurm
// job array would let the scheduler place each protein separately, but the
// Slurm module's handling of arrays is not confirmed yet (requests/S1), so
// this is the documented fallback. Each protein appends one line to
// timings.tsv - index, length, seconds, exit code, status - never a name, so
// the file can feed the anonymised speed database as it stands.

const { formatFasta } = require('./fastaTools');

const MAX_DAYS = 999;
const MEM_UNITS_TO_MB = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };
const TERMINAL_STATES = [
  'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY',
  'PREEMPTED', 'BOOT_FAIL', 'DEADLINE', 'REVOKED'
];

// Slurm may report "CANCELLED by 1234" or "CANCELLED+"; only the first word counts.
function isTerminalState(state) {
  if (typeof state !== 'string') return false;
  return TERMINAL_STATES.includes(state.trim().split(/[\s+]/)[0].toUpperCase());
}

// Slurm time limits: "D-HH[:MM[:SS]]", "HH:MM:SS", "MM:SS" or plain minutes.
function parseSlurmTime(text) {
  const withDays = /^(\d+)-(\d+)(?::(\d+))?(?::(\d+))?$/.exec(text);
  if (withDays) {
    const [, d, h, m = 0, s = 0] = withDays;
    return ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s);
  }
  const plain = /^(\d+)(?::(\d+))?(?::(\d+))?$/.exec(text);
  if (!plain) return null;
  const parts = plain.slice(1).filter(p => p !== undefined).map(Number);
  if (parts.length === 1) return parts[0] * 60;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return (parts[0] * 60 + parts[1]) * 60 + parts[2];
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatSlurmTime(totalSeconds) {
  const capped = Math.min(Math.ceil(totalSeconds), MAX_DAYS * 86400 + 86399);
  const days = Math.floor(capped / 86400);
  const rest = capped % 86400;
  const clock = `${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}:${pad(rest % 60)}`;
  return days > 0 ? `${days}-${clock}` : clock;
}

// "64G" -> 65536. No unit means megabytes, as in sbatch.
function parseMemMB(text) {
  const match = /^(\d+)([KMGT]?)$/i.exec(text);
  if (!match) return null;
  return Math.ceil(Number(match[1]) * MEM_UNITS_TO_MB[(match[2] || 'M').toUpperCase()]);
}

// settings: the caller's Setup values. toDo: proteins that will really be
// searched (the rest are skipped at once). The allocation holds `parallel`
// per-protein slots; its time limit is the per-protein limit times the number
// of rounds it takes to get through toDo proteins - a ceiling, not a guess.
function msaResources(settings, toDo) {
  const work = Math.max(1, toDo);
  const parallel = Math.max(1, Math.min(settings.msa_array_throttle, work));
  const rounds = Math.ceil(work / parallel);
  const memMB = parseMemMB(settings.msa_mem) * parallel;
  return {
    parallel,
    rounds,
    cpus: settings.msa_cpus_per_task * parallel,
    memMB,
    mem: `${memMB}M`,
    timeSeconds: parseSlurmTime(settings.msa_time) * rounds,
    time: formatSlurmTime(parseSlurmTime(settings.msa_time) * rounds)
  };
}

// Reasons a run cannot start yet, as sentences for the user.
function msaProblems(settings) {
  const problems = [];
  if (!settings.msa_use_mmseqs2 && !settings.data_dir) {
    problems.push('Set the AlphaPulldown database directory in Setup, or tick the MMseqs2 option there.');
  }
  return problems;
}

// One entry per distinct protein name, in the order first seen. A name that
// carries two different sequences (say as bait and as candidate) cannot be
// searched once under one name, so it is reported instead.
function uniqueProteins(rows) {
  const byName = new Map();
  const conflicts = new Set();
  rows.forEach(r => {
    const known = byName.get(r.name);
    if (!known) byName.set(r.name, { name: r.name, length: r.length, sequence: r.sequence });
    else if (known.sequence !== r.sequence) conflicts.add(r.name);
  });
  return { proteins: [...byName.values()], conflicts: [...conflicts] };
}

// timings.tsv -> [{ index, length, seconds, exit, status }]. Lines that do
// not parse are ignored; a protein listed twice (a retry) keeps its last line.
function parseTimings(text) {
  const byIndex = new Map();
  String(text || '').split('\n').forEach(line => {
    const [index, length, seconds, exit, status] = line.split('\t');
    const row = { index: Number(index), length: Number(length), seconds: Number(seconds), exit: Number(exit), status };
    const valid = Number.isInteger(row.index) && row.index >= 1 && Number.isInteger(row.length) && row.length >= 1
      && Number.isInteger(row.seconds) && row.seconds >= 0 && Number.isInteger(row.exit)
      && ['ok', 'skipped', 'failed', 'oom'].includes(status);
    if (valid) byIndex.set(row.index, row);
  });
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function progressOf(timings) {
  const count = status => timings.filter(t => t.status === status).length;
  return { searched: count('ok'), skipped: count('skipped'), failed: count('failed') + count('oom') };
}

// Speed samples from a finished run: skipped proteins took no time and teach
// nothing. exit 137 (killed) is reported as 'oom', anything else non-zero as 'failed'.
function samplesFromTimings(timings, { method, hardware }) {
  return timings
    .filter(t => t.status !== 'skipped')
    .map(t => ({
      stage: 'msa',
      lenA: t.length,
      method,
      hardware,
      outcome: t.status,
      runSeconds: t.seconds
    }));
}

// Single-quoted for the shell. Newlines and NUL cannot be quoted safely.
function shellQuote(value) {
  const text = String(value);
  if (/[\n\r\0]/.test(text)) throw new Error('Refusing to put a control character into a script');
  return `'${text.replace(/'/g, '\'\\\'\'')}'`;
}

function activationLines(settings) {
  return settings.env_manager === 'conda'
    ? ['eval "$(conda shell.bash hook)"', `conda activate ${settings.env_name}`]
    : ['eval "$(micromamba shell hook --shell bash)"', `micromamba activate ${settings.env_name}`];
}

// The flags of one create_individual_features.py call. $i is the 1-based
// position of the protein in msa_input.fasta. --use_precomputed_msas lets a
// retry reuse MSA files an earlier attempt already saved; a forced redo
// starts again from nothing.
function featuresArgs(settings, { featuresDir, redo }) {
  const args = [
    '--fasta_paths=msa_input.fasta',
    `--output_dir=${shellQuote(featuresDir)}`,
    `--max_template_date=${settings.max_template_date}`,
    '--save_msa_files=True',
    '--seq_index="$i"'
  ];
  if (settings.msa_use_mmseqs2) args.push('--use_mmseqs2=True');
  else args.push(`--data_dir=${shellQuote(settings.data_dir)}`);
  if (!redo) args.push('--skip_existing=True', '--use_precomputed_msas=True');
  return args;
}

// The script xargs calls once per protein ($1 = position in msa_input.fasta).
// It skips a protein whose features already exist (recorded as 'skipped'),
// times the search and appends one line to timings.tsv. It exits non-zero
// when the search failed, so the job as a whole ends FAILED if any did.
function buildRunOneScript(settings, { featuresDir, redo }) {
  const lines = [
    '#!/bin/bash',
    '# Searches one protein: $1 is its 1-based position in msa_input.fasta.',
    'i="$1"',
    'name=$(sed -n -e "$i p" msa_names.txt)',
    'len=$(sed -n -e "$i p" msa_lengths.txt)',
    `features=${shellQuote(featuresDir)}`
  ];
  if (!redo) {
    lines.push(
      'if [ -e "$features/$name.pkl" ] || [ -e "$features/$name.pkl.xz" ]; then',
      '  printf \'%s\\t%s\\t0\\t0\\tskipped\\n\' "$i" "$len" >> timings.tsv',
      '  exit 0',
      'fi'
    );
  }
  lines.push(
    'start=$(date +%s)',
    `create_individual_features.py ${featuresArgs(settings, { featuresDir, redo }).join(' ')} > "logs/$i.log" 2>&1`,
    'code=$?',
    'end=$(date +%s)',
    'status=ok',
    'if [ "$code" -eq 137 ]; then status=oom; elif [ "$code" -ne 0 ]; then status=failed; fi',
    'printf \'%s\\t%s\\t%s\\t%s\\t%s\\n\' "$i" "$len" "$((end - start))" "$code" "$status" >> timings.tsv',
    '[ "$code" -eq 0 ]',
    ''
  );
  return lines.join('\n');
}

// slug: a single dash-separated token (sbatch splits directive values on
// whitespace). count: how many proteins msa_input.fasta holds.
function buildSubmitScript({ slug, settings, email, resources, count }) {
  const lines = [
    // -i: needed for the micromamba/conda shell hook below to define its
    // shell function; non-interactive bash skips that setup.
    '#!/bin/bash -i',
    `#SBATCH --job-name=${slug}`,
    '#SBATCH --nodes=1',
    '#SBATCH --ntasks=1'
  ];
  if (settings.msa_partition) lines.push(`#SBATCH --partition=${settings.msa_partition}`);
  lines.push(
    `#SBATCH --cpus-per-task=${resources.cpus}`,
    `#SBATCH --mem=${resources.mem}`,
    `#SBATCH --time=${resources.time}`,
    '#SBATCH --output=slurm.out',
    '#SBATCH --error=slurm.err'
  );
  if (email) {
    lines.push(`#SBATCH --mail-user=${email}`);
    if (settings.slurm_mail_type) lines.push(`#SBATCH --mail-type=${settings.slurm_mail_type}`);
  }
  lines.push(
    '',
    // No -e: one protein failing must not stop the others.
    'set -uo pipefail',
    '',
    ...activationLines(settings),
    '',
    'mkdir -p logs',
    `echo "Searching ${count} proteins, ${resources.parallel} at a time"`,
    `seq 1 ${count} | xargs -P ${resources.parallel} -n 1 bash ./run_one.sh`,
    ''
  );
  return lines.join('\n');
}

// Everything written into a run's folder, as { name: content }.
function buildRunFiles({ slug, settings, email, resources, proteins, featuresDir, redo }) {
  return {
    'submit.sh': buildSubmitScript({ slug, settings, email, resources, count: proteins.length }),
    'run_one.sh': buildRunOneScript(settings, { featuresDir, redo }),
    'msa_input.fasta': formatFasta(proteins),
    'msa_names.txt': proteins.map(p => `${p.name}\n`).join(''),
    'msa_lengths.txt': proteins.map(p => `${p.length}\n`).join('')
  };
}

module.exports = {
  TERMINAL_STATES,
  isTerminalState,
  parseSlurmTime,
  formatSlurmTime,
  parseMemMB,
  msaResources,
  msaProblems,
  uniqueProteins,
  parseTimings,
  progressOf,
  samplesFromTimings,
  shellQuote,
  buildRunOneScript,
  buildSubmitScript,
  buildRunFiles
};
