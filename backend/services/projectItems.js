// What this module has in a Science project is listed on the project's page:
// each target and each run is registered as a project item through Science's
// own route (core passes our module id with the call, so it cannot be faked).
// Registering is a convenience for that page: when it fails the work is saved
// anyway, the failure is reported, and the next change registers it again.
const ITEM_TYPES = { target: 'target', msaRun: 'msa_run', cofoldRun: 'cofold_run' };
const LINK = '/dashboard?tab=alphapulldown';

function itemsPath(scienceId) {
  return `/external/projects/${Number(scienceId)}/items`;
}

function failureText(result) {
  return result.error || (result.data && result.data.error) || `Science answered ${result.status}`;
}

// item: { type, id, title, status }. Returns '' or a sentence saying why the
// project page was not updated. Never throws.
async function registerItem(coreApi, req, scienceId, item) {
  try {
    const result = await coreApi.callModule(req.headers.authorization, 'science', 'POST', itemsPath(scienceId), {
      body: { item_type: item.type, item_id: String(item.id), title: String(item.title).slice(0, 255), status: item.status, link: LINK }
    });
    return result.ok ? '' : `The project's page in Science was not updated: ${failureText(result)}`;
  } catch (err) {
    return `The project's page in Science was not updated: ${err.message}`;
  }
}

async function removeItem(coreApi, req, scienceId, type, id) {
  try {
    const result = await coreApi.callModule(req.headers.authorization, 'science', 'DELETE', `${itemsPath(scienceId)}/${encodeURIComponent(type)}/${encodeURIComponent(String(id))}`);
    return result.ok || result.status === 404 ? '' : `The project's page in Science still lists it: ${failureText(result)}`;
  } catch (err) {
    return `The project's page in Science still lists it: ${err.message}`;
  }
}

// How an item is named and described, shared with the one-time move of old
// projects so both write the same lines.
function describeItem(type, id, { name, status }) {
  const titles = { target: `Target: ${name}`, msa_run: `AlphaPulldown feature (MSA) run ${id}`, cofold_run: `AlphaPulldown co-folding run ${id}` };
  return { type, id, title: String(titles[type]).slice(0, 255), status: String(status || '').slice(0, 64) };
}

// A co-folding run in one word, from its cancel mark and its pairs' counts.
function cofoldState(cancelled, counts) {
  if (cancelled) return 'cancelled';
  if (counts.queued + counts.running > 0) return 'running';
  return counts.failed > 0 ? 'finished with failures' : 'finished';
}

module.exports = { ITEM_TYPES, LINK, describeItem, cofoldState, registerItem, removeItem };
