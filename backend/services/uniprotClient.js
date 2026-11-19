// Thin client for UniProt's public REST API (https://rest.uniprot.org),
// called from this module's backend with Node's built-in fetch. Response
// shapes were checked against the live API: search results carry
// primaryAccession, uniProtkbId, genes[].geneName.value,
// proteinDescription.recommendedName.fullName.value (or submissionNames for
// unreviewed entries), organism.scientificName and sequence.length;
// proteome search results carry id, taxonomy.{scientificName,taxonId} and
// proteinCount.
const fsp = require('fs').promises;
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');

const BASE = 'https://rest.uniprot.org';
const USER_AGENT = 'MFF-Module-AlphaPulldown';
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const ACCESSIONS_PER_REQUEST = 100;

const UPID = /^UP\d{9}$/;
const ACCESSION = /^[A-Z][0-9][A-Z0-9]{3}[0-9]([A-Z][A-Z0-9]{2}[0-9])?(-\d+)?$/i;

async function request(url, { timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    throw new Error(`${err.message}${code}`);
  }
  if (!res.ok) throw new Error(`UniProt answered ${res.status}`);
  return res;
}

function buildProteinQuery({ query, organism, reviewedOnly }) {
  const parts = [`(${query})`];
  if (organism) {
    parts.push(/^\d+$/.test(organism) ? `(organism_id:${organism})` : `(organism_name:"${organism.replace(/"/g, '')}")`);
  }
  if (reviewedOnly) parts.push('(reviewed:true)');
  return parts.join(' AND ');
}

function toProteinResult(r) {
  const description = r.proteinDescription || {};
  const name = (description.recommendedName && description.recommendedName.fullName && description.recommendedName.fullName.value)
    || (description.submissionNames && description.submissionNames[0] && description.submissionNames[0].fullName.value)
    || '';
  return {
    accession: r.primaryAccession,
    entry: r.uniProtkbId,
    gene: (r.genes && r.genes[0] && r.genes[0].geneName && r.genes[0].geneName.value) || '',
    name,
    organism: (r.organism && r.organism.scientificName) || '',
    length: (r.sequence && r.sequence.length) || null,
    reviewed: /reviewed \(Swiss-Prot\)/.test(r.entryType || '')
  };
}

async function searchProteins({ query, organism = '', reviewedOnly = true, size = 25 }) {
  const params = new URLSearchParams({
    query: buildProteinQuery({ query, organism, reviewedOnly }),
    format: 'json',
    size: String(size),
    fields: 'accession,id,gene_names,protein_name,organism_name,length'
  });
  const res = await request(`${BASE}/uniprotkb/search?${params}`);
  const body = await res.json();
  return (body.results || []).map(toProteinResult);
}

async function searchProteomes({ query, size = 20 }) {
  const params = new URLSearchParams({
    query: UPID.test(query) ? `upid:${query}` : query,
    format: 'json',
    size: String(size),
    fields: 'upid,organism,organism_id,protein_count'
  });
  const res = await request(`${BASE}/proteomes/search?${params}`);
  const body = await res.json();
  return (body.results || []).map(r => ({
    upid: r.id,
    organism: (r.taxonomy && r.taxonomy.scientificName) || '',
    taxId: (r.taxonomy && r.taxonomy.taxonId) || null,
    proteinCount: r.proteinCount || 0
  }));
}

// Returns the FASTA text for the given accessions (UniProt silently omits
// ones it does not know, so callers compare what came back).
async function fetchFasta(accessions) {
  let text = '';
  for (let i = 0; i < accessions.length; i += ACCESSIONS_PER_REQUEST) {
    const chunk = accessions.slice(i, i + ACCESSIONS_PER_REQUEST);
    const res = await request(`${BASE}/uniprotkb/accessions?accessions=${chunk.join(',')}&format=fasta`);
    text += await res.text();
  }
  return text;
}

function proteomeQuery(upid, reviewedOnly) {
  return `(proteome:${upid})${reviewedOnly ? ' AND (reviewed:true)' : ''}`;
}

// Which UniProt release is live and how many entries the proteome has in it,
// without downloading it: the headers of a one-entry search say so. Lets the
// library skip a download it already holds.
async function peekRelease({ upid, reviewedOnly }) {
  const params = new URLSearchParams({ query: proteomeQuery(upid, reviewedOnly), format: 'fasta', size: '1' });
  const res = await request(`${BASE}/uniprotkb/search?${params}`);
  await res.arrayBuffer();
  return {
    release: res.headers.get('x-uniprot-release') || '',
    releaseDate: res.headers.get('x-uniprot-release-date') || '',
    total: Number(res.headers.get('x-total-results')) || 0
  };
}

// The proteome record itself: organism, taxon, type (reference or not),
// genome assembly, BUSCO completeness - the labels the library keeps.
async function proteomeInfo(upid) {
  const res = await request(`${BASE}/proteomes/${upid}?format=json`);
  const p = await res.json();
  const busco = p.proteomeCompletenessReport && p.proteomeCompletenessReport.buscoReport;
  return {
    upid: p.id,
    organism: (p.taxonomy && p.taxonomy.scientificName) || '',
    taxId: (p.taxonomy && p.taxonomy.taxonId) || null,
    mnemonic: (p.taxonomy && p.taxonomy.mnemonic) || '',
    proteomeType: p.proteomeType || '',
    strain: p.strain || '',
    modified: p.modified || '',
    proteinCount: p.proteinCount || 0,
    genomeAssembly: p.genomeAssembly ? { id: p.genomeAssembly.assemblyId || '', level: p.genomeAssembly.level || '', source: p.genomeAssembly.source || '' } : null,
    busco: busco ? { complete: busco.complete, total: busco.total, score: busco.score, lineage: busco.lineageDb || '' } : null,
    lineage: Array.isArray(p.taxonLineage) ? p.taxonLineage.map(t => t.scientificName).filter(Boolean) : []
  };
}

// Streams a whole proteome's FASTA to destPath (via destPath.part, renamed
// on success) and returns what the library records about the download: the
// UniProt release the server answered with, the SHA-256 of the bytes, the
// number of entries and the size. onBytes(n) reports progress. Refuses
// downloads over MAX_DOWNLOAD_BYTES and empty results.
async function downloadProteome({ upid, reviewedOnly, destPath, onBytes }) {
  const query = proteomeQuery(upid, reviewedOnly);
  const res = await request(`${BASE}/uniprotkb/stream?query=${encodeURIComponent(query)}&format=fasta`, { timeoutMs: 15 * 60 * 1000 });
  const tmp = `${destPath}.part`;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let entries = 0;
  let lineStart = true;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) return callback(new Error('Download is larger than the 300 MB limit'));
      hash.update(chunk);
      for (let i = 0; i < chunk.length; i += 1) {
        if (lineStart && chunk[i] === 62) entries += 1;
        lineStart = chunk[i] === 10;
      }
      onBytes(bytes);
      return callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
    if (bytes === 0) throw new Error('UniProt returned no sequences for this proteome');
    await fsp.rename(tmp, destPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return {
    release: res.headers.get('x-uniprot-release') || '',
    releaseDate: res.headers.get('x-uniprot-release-date') || '',
    sha256: hash.digest('hex'),
    entries,
    bytes
  };
}

module.exports = {
  UPID,
  ACCESSION,
  searchProteins,
  searchProteomes,
  fetchFasta,
  peekRelease,
  proteomeInfo,
  downloadProteome
};
