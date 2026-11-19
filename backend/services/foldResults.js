// What AlphaPulldown's AlphaFold 3 backend leaves for one predicted complex,
// and the scores read from it. Pure functions - no disk, no database - so they
// are unit-tested without a running mff-core.
//
// run_multimer_jobs.py --fold_backend=alphafold3 --output_path=<dir> writes one
// folder per complex, <dir>/<fold name>/, holding AlphaFold 3's own files:
//
//   <fold>_model.cif                 the best-ranked model
//   <fold>_summary_confidences.json  its scores (ptm, iptm, ranking_score, ...)
//   <fold>_confidences.json          per-residue pLDDT and the full PAE matrix
//   <fold>_ranking_scores.csv        every seed/sample with its ranking score
//   seed-<n>_sample-<m>/             the same files for each other sample
//
// The fold name is AlphaFold 3's sanitised job name (lower case), so nothing
// here depends on it: the folder is simply the one that holds a summary file.

const SUMMARY_SUFFIX = '_summary_confidences.json';
const MODEL_SUFFIX = '_model.cif';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// The smallest value off the diagonal of a square matrix: for the
// chain_pair_pae_min matrix that is the best (lowest) PAE between two
// different chains, AlphaFold 3's measure of how confidently the interface
// is placed. Null for a single chain or a malformed matrix.
function offDiagonalMin(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 2) return null;
  let best = null;
  for (let i = 0; i < matrix.length; i += 1) {
    if (!Array.isArray(matrix[i]) || matrix[i].length !== matrix.length) return null;
    for (let j = 0; j < matrix.length; j += 1) {
      const value = finite(matrix[i][j]);
      if (i !== j && value !== null && (best === null || value < best)) best = value;
    }
  }
  return best;
}

// summary: the parsed <fold>_summary_confidences.json. A monomer has no
// meaningful iptm (AlphaFold 3 reports it as null or 0), so it is left null.
function scoresFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const chains = Array.isArray(summary.chain_ptm) ? summary.chain_ptm.length : 0;
  return {
    iptm: chains > 1 ? finite(summary.iptm) : null,
    ptm: finite(summary.ptm),
    rankingScore: finite(summary.ranking_score),
    interfacePaeMin: offDiagonalMin(summary.chain_pair_pae_min),
    hasClash: summary.has_clash === undefined || summary.has_clash === null ? null : (summary.has_clash ? 1 : 0),
    fractionDisordered: finite(summary.fraction_disordered),
    chains
  };
}

// names: the file names inside ONE fold folder. The summary and model of the
// best-ranked sample sit at the top of that folder.
function pickFiles(names) {
  const summary = names.find(n => n.endsWith(SUMMARY_SUFFIX)) || null;
  const model = names.find(n => n.endsWith(MODEL_SUFFIX)) || null;
  return { summary, model };
}

module.exports = { SUMMARY_SUFFIX, MODEL_SUFFIX, offDiagonalMin, scoresFromSummary, pickFiles };
