// The labels that say what was run and where, shared by the code that
// records a speed sample and the code that looks one up - they must agree
// character for character or an estimate never finds its samples.

// 'af3': AlphaPulldown's AlphaFold 3 data pipeline (jackhmmer/hmmsearch
// against the local database directory). Older samples carry 'local' (the
// AlphaFold 2 pipeline) or 'mmseqs2'; they are never mixed with this label.
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
  return { method: msaMethod(), hardware: msaHardware(settings) };
}

module.exports = { msaMethod, msaHardware, msaProfile };
