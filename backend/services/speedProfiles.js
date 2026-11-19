// The labels that say what was run and where, shared by the code that
// records a speed sample and the code that looks one up - they must agree
// character for character or an estimate never finds its samples.

// The feature stage always runs AlphaPulldown's AlphaFold 3 data pipeline
// against the local databases, so there is one method label for it.
function msaMethod() {
  return 'af3';
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

// e.g. 'gpu/gpu-1' or 'gpu/gpu-rtx_a5000-1': the partition and what was asked
// of it ('nogpu' when no GRES is requested).
function foldHardware(settings) {
  const partition = (settings.fold_partition || 'default').replace(/,/g, '+').slice(0, 40);
  const gres = (settings.fold_gres || 'nogpu').replace(/:/g, '-').slice(0, 50);
  return `${partition}/${gres}`;
}

module.exports = { msaMethod, msaHardware, msaProfile, foldHardware };
