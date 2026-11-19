// Works out, for a set of a project's proteins, which library proteome version
// and which feature set each really came from - read from the project's own
// features folder, where a shared feature is a link into its set's folder, so
// the answer is what is on disk, not what was planned. Used when a
// prediction run is created (its provenance record) and by the methods route.
const fs = require('fs').promises;
const path = require('path');
const paths = require('./libraryPaths');

const EXTENSIONS = ['json.xz', 'json'];

async function setKeyOfLink(config, featuresDir, name) {
  if (!config.configured || !featuresDir) return null;
  for (const ext of EXTENSIONS) {
    const link = path.join(featuresDir, `${name}_af3_input.${ext}`);
    try {
      const target = await fs.readlink(link);
      const key = paths.featureSetKeyOfPath(config.libraryDir, path.resolve(path.dirname(link), target));
      if (key) return key;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EINVAL') throw err;
    }
  }
  return null;
}

// proteins: [{ name, proteome_id }]. Returns { groups, localProteins } where
// each group is { proteome, set, count } as provenance.proteomeRecords wants;
// set is null for a library protein whose features are not linked yet.
async function groupsFor(conn, config, featuresDir, proteins) {
  let localProteins = 0;
  const buckets = new Map();
  for (const p of proteins) {
    if (!p.proteome_id) {
      localProteins += 1;
      continue;
    }
    const key = await setKeyOfLink(config, featuresDir, p.name);
    const bucket = `${Number(p.proteome_id)}|${key || ''}`;
    const known = buckets.get(bucket) || { proteomeId: Number(p.proteome_id), key, count: 0 };
    known.count += 1;
    buckets.set(bucket, known);
  }
  const list = [...buckets.values()];
  if (list.length === 0) return { groups: [], localProteins };

  const ids = [...new Set(list.map(b => b.proteomeId))];
  const proteomes = await conn.query(`SELECT * FROM alphapulldown_library_proteomes WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  const keys = [...new Set(list.map(b => b.key).filter(Boolean))];
  const sets = keys.length > 0
    ? await conn.query(`SELECT * FROM alphapulldown_library_feature_sets WHERE set_key IN (${keys.map(() => '?').join(', ')})`, keys)
    : [];
  const groups = [];
  for (const b of list) {
    const proteome = proteomes.find(r => Number(r.id) === b.proteomeId);
    if (!proteome) {
      localProteins += b.count;
      continue;
    }
    groups.push({ proteome, set: sets.find(s => s.set_key === b.key) || null, count: b.count });
  }
  return { groups, localProteins };
}

module.exports = { groupsFor };
