// Builds the AlphaFold3-dialect input JSON that `abcfold` expects as its
// first CLI argument (ABCFold wraps AF3 and several other structure
// predictors, but all of them consume this one input format - see
// https://github.com/rigdenlab/ABCFold).
//
// `dialect` + `version` are REQUIRED by AlphaFold3's own parser
// (folding_input.py's Input.from_json: dialect must be 'alphafold3',
// version one of 1-4) - abcfold passes top-level keys through untouched, so
// without them every job died in AF3 with "AlphaFold 3 input JSON must
// contain `dialect` and `version` fields" (a real failure, seen in a job's
// slurm.out). version 2 is what njp158's own known-working input
// (pyp1.json) uses on this cluster with this abcfold.

function buildAf3Input({ name, sequences, modelSeeds }) {
  return {
    dialect: 'alphafold3',
    version: 2,
    name,
    sequences: sequences.map(entry => {
      if (entry.type === 'protein') {
        return { protein: { id: entry.id, sequence: entry.sequence } };
      }
      if (entry.ccd) {
        return { ligand: { id: entry.id, ccdCodes: [entry.ccd] } };
      }
      return { ligand: { id: entry.id, smiles: entry.smiles } };
    }),
    modelSeeds
  };
}

function validateAf3Input(input) {
  const errors = [];
  if (!input.name) errors.push('name is required');
  if (!Array.isArray(input.sequences) || input.sequences.length === 0) {
    errors.push('at least one sequence entry is required');
  } else {
    input.sequences.forEach((entry, i) => {
      const inner = entry.protein || entry.ligand;
      if (!inner || !inner.id) errors.push(`sequence entry ${i + 1} is missing an id`);
    });
  }
  return errors;
}

module.exports = { buildAf3Input, validateAf3Input };
