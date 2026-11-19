// Fetches a 3D model of the target from the two public archives the Target
// tab offers: the Protein Data Bank (a PDB entry id) and the AlphaFold
// Protein Structure Database (a UniProt accession). Both are called from this
// module's backend with Node's built-in fetch and answer with the mmCIF text
// plus what is worth recording about where it came from. Models predicted
// with ABCFold and uploaded files do not come through here.
const USER_AGENT = 'MFF-Module-AlphaPulldown';
const MAX_BYTES = 60 * 1024 * 1024;
const PDB_ID = /^[0-9][A-Za-z0-9]{3}$/;
const ACCESSION = /^[A-Z][0-9][A-Z0-9]{3}[0-9]([A-Z][A-Z0-9]{2}[0-9])?$/;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

async function get(url, { json = false } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
  } catch (err) {
    const code = err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    throw failure(502, `${new URL(url).host} could not be reached: ${err.message}${code}`);
  }
  if (res.status === 404) throw failure(404, 'not found');
  if (!res.ok) throw failure(502, `${new URL(url).host} answered ${res.status}`);
  if (json) return res.json();
  const length = Number(res.headers.get('content-length'));
  if (length > MAX_BYTES) throw failure(400, 'The model file is larger than 60 MB');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw failure(400, 'The model file is larger than 60 MB');
  return buffer.toString('utf8');
}

// -> { text, source: { source, modelId, version, url } }
async function fetchPdb(id) {
  const entry = String(id || '').trim().toUpperCase();
  if (!PDB_ID.test(entry)) throw failure(400, `${id} is not a PDB entry id (four characters, like 1CRN)`);
  const url = `https://files.rcsb.org/download/${entry}.cif`;
  try {
    return { text: await get(url), source: { source: 'pdb', modelId: entry, version: '', url } };
  } catch (err) {
    if (err.status === 404) throw failure(404, `The PDB has no entry ${entry}`);
    throw err;
  }
}

// -> { text, source: { source, modelId, version, url, createdDate, tool } }
async function fetchAlphafold(accession) {
  const wanted = String(accession || '').trim().toUpperCase();
  if (!ACCESSION.test(wanted)) throw failure(400, `${accession} is not a UniProt accession`);
  let predictions;
  try {
    predictions = await get(`https://alphafold.ebi.ac.uk/api/prediction/${wanted}`, { json: true });
  } catch (err) {
    if (err.status === 404) throw failure(404, `The AlphaFold database has no model for ${wanted}`);
    throw err;
  }
  const model = Array.isArray(predictions) ? predictions[0] : null;
  if (!model || !model.cifUrl) throw failure(404, `The AlphaFold database has no model for ${wanted}`);
  const text = await get(model.cifUrl);
  return {
    text,
    source: {
      source: 'alphafold_db',
      modelId: model.entryId || model.modelEntityId || wanted,
      version: model.latestVersion ? `v${model.latestVersion}` : '',
      url: model.cifUrl,
      createdDate: model.modelCreatedDate || '',
      tool: model.toolUsed || ''
    }
  };
}

module.exports = { fetchPdb, fetchAlphafold, PDB_ID };
