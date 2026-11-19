// The labels that say what was run and where, shared by the code that
// records a speed sample and the code that looks one up - they must agree
// character for character or an estimate never finds its samples.

// 'mmseqs2' (remote ColabFold search) or 'local' (jackhmmer/hhblits against
// the database directory) - the two differ by orders of magnitude.
function msaMethod(settings) {
  return settings.msa_use_mmseqs2 ? 'mmseqs2' : 'local';
}

// e.g. 'cpu_long/8cpu', or 'default/8cpu' when no partition is set (several
// partitions listed with commas read 'a+b').
function msaHardware(settings) {
  const partition = (settings.msa_partition || 'default').replace(/,/g, '+').slice(0, 80);
  return `${partition}/${settings.msa_cpus_per_task}cpu`;
}

function msaProfile(settings) {
  return { method: msaMethod(settings), hardware: msaHardware(settings) };
}

module.exports = { msaMethod, msaHardware, msaProfile };
