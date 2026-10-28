// Builds the `abcfold` CLI invocation:
//   abcfold <input_json> <output_dir> [flags]
// Model selection is mandatory (at least one of -a/-b/-c/-o/-p). No -r/
// RoseTTAFold3 flag exists - confirmed directly against the real,
// installed `abcfold --help` on this cluster (v1.1.2, whose own package
// summary is "Tool to run & compare AlphaFold3, Boltz, Chai-1, OpenFold3
// and Protenix" - RoseTTAFold3 was never part of this tool at all, not a
// flag this version dropped). A job requesting -r fails immediately with
// "abcfold: error: unrecognized arguments: -r" - real evidence, not a
// guess; don't re-add rosettafold3 without re-confirming against a real
// `abcfold --help` first.
// --ligand_smiles/--ligand_ccd/--ligand_chain are Boltz-2 AFFINITY SCORING
// flags - a separate concern from the structure-prediction ligands that
// belong in the input JSON's own `sequences` array (see af3InputBuilder.js).
//
// --database vs --mmseqs2: two different, mutually-exclusive MSA methods
// (confirmed against the real `abcfold --help`) - --mmseqs2 submits
// sequences to the public ColabFold API (api.colabfold.com) for remote
// MSA generation; --database points at a local genetic-sequence database
// for AlphaFold3's own built-in, fully offline MSA generation. This
// cluster already has a full local database (confirmed present at
// /home/linuxhomes/software/genetic_db - uniref90/uniref30/bfd/mgnify/
// pdb70/pdb_seqres/pdb_mmcif/uniprot/params) - defaulting to --mmseqs2
// meant every job depended on reaching a public, third-party API from a
// compute node for no real reason, and a real job failed exactly this way
// (DNS resolution to api.colabfold.com failed mid-run). --database only
// gets pushed when mmseqs2 is off - an explicit mmseqs2 choice always
// wins, matching abcfold's own mutually-exclusive flag semantics.

const MODEL_FLAGS = {
  alphafold3: '-a',
  boltz: '-b',
  chai1: '-c',
  openfold3: '-o',
  protenix: '-p'
};

function buildAbcfoldCommand({
  inputJsonFilename,
  outputDir,
  models,
  mmseqs2,
  databaseDir,
  templates,
  customTemplatePath,
  ligandSmiles,
  ligandCcd,
  ligandChain,
  modelParamsPath,
  override,
  noVisuals,
  noServer
}) {
  if (!models || models.length === 0) {
    throw new Error('At least one model must be selected');
  }

  const parts = ['abcfold', inputJsonFilename, outputDir];
  models.forEach(model => {
    const flag = MODEL_FLAGS[model];
    if (!flag) throw new Error(`Unknown model: ${model}`);
    parts.push(flag);
  });
  if (mmseqs2) {
    parts.push('--mmseqs2');
  } else if (databaseDir) {
    parts.push('--database', databaseDir);
  }
  if (templates) parts.push('--templates');
  if (customTemplatePath) parts.push('--custom_template', customTemplatePath);
  if (ligandSmiles) parts.push('--ligand_smiles', `"${ligandSmiles}"`);
  if (ligandCcd) parts.push('--ligand_ccd', ligandCcd);
  if (ligandChain) parts.push('--ligand_chain', ligandChain);
  if (modelParamsPath) parts.push('--model_params', modelParamsPath);
  if (override) parts.push('--override');
  if (noVisuals) parts.push('--no_visuals');
  // --no_server only skips starting the local web server; the output page
  // (index.html) is still written. --no_visuals, by contrast, skips the
  // page entirely. Both are plain checkboxes on the Run tab.
  if (noServer) parts.push('--no_server');

  return parts.join(' ');
}

module.exports = { MODEL_FLAGS, buildAbcfoldCommand };
