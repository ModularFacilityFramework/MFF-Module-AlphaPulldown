// Which proteins of a project already have AlphaFold 3 features on disk.
// Shared by the Features tab (what is left to search) and the Prediction tab
// (what is missing before a run can start).
const fs = require('fs').promises;
const { featureNameOf } = require('./msaPlan');

// Names with a <name>_af3_input.json or <name>_af3_input.json.xz in `dir`.
// A folder that does not exist yet holds none.
async function namesWithFeatures(dir) {
  try {
    const entries = await fs.readdir(dir);
    return new Set(entries.map(featureNameOf).filter(Boolean));
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

module.exports = { namesWithFeatures };
