// The one-time move of the module's own old projects into Science (data only,
// through Science's API; the tables themselves are described by
// db/schema.sql). It runs in the background after the module starts and is
// safe to repeat:
//   1. each old project (a link row with no science_project_id) becomes a
//      Science project owned by its owner (through Science's import route,
//      which also takes an owner who may not create projects), and its targets
//      and runs are listed on that project's page;
//   2. targets and runs whose old project no longer exists have no project:
//      they are listed in Science's "Project template", in their owner's name.
// What cannot be moved yet (Science not ready, an owner who cannot sign in)
// stays as it is - readable by its owner and staff - and is tried again.
const items = require('./projectItems');
const cofold = require('./cofoldPlan');

const FIRST_DELAY_MS = 20 * 1000;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];
// About three and a half hours of trying. Every call as another user is audited
// by core, so something that cannot be moved must not be asked about for ever;
// the next start of the module tries again.
const MAX_RETRIES = 8;
const TEMPLATE_BATCH = 200;
// Answers that will not change by asking again.
const PERMANENT = [400, 409];

// Written in the Science project's description; it is how a project made just
// before an interruption is found again instead of being made twice.
const marker = link => `[AlphaPulldown project ${link.id}]`;

function failure(result) {
  return result.reason || result.error || (result.data && result.data.error) || `status ${result.status}`;
}

async function createdEarlier(coreApi, link) {
  const found = await coreApi.callModuleAsUser(link.owner_id, 'science', 'GET', '/external/projects', {
    params: { scope: 'mine', search: String(link.name).slice(0, 200), archived: 1 }
  });
  if (!found.ok) throw new Error(`could not list the owner's projects: ${failure(found)}`);
  for (const project of Array.isArray(found.data) ? found.data : []) {
    let { description } = project;
    if (description === undefined && project.title === link.name) {
      const one = await coreApi.callModuleAsUser(link.owner_id, 'science', 'GET', `/external/projects/${project.id}`);
      description = one.ok && one.data ? one.data.description : '';
    }
    if (String(description || '').includes(marker(link))) return project;
  }
  return null;
}

// Science's import route is for old projects only. It needs no "has a project"
// right, and answers a repeat for the same old_id with the same project. The
// old_id is the link row's id: rows are never deleted, so it is never reused.
// A Science older than the route answers 404; the ordinary creating route is
// used then (it refuses an owner who may not create projects).
async function importProject(coreApi, link, project) {
  const imported = await coreApi.callModuleAsUser(link.owner_id, 'science', 'POST', '/external/project-imports', {
    body: { old_id: String(link.id), ...project }
  });
  if (imported.ok || imported.status !== 404) return imported;
  return coreApi.callModuleAsUser(link.owner_id, 'science', 'POST', '/external/projects', { body: project });
}

async function createProject(coreApi, link) {
  // A project made without the import route is known to Science only by the
  // mark, so this comes first.
  const earlier = await createdEarlier(coreApi, link);
  if (earlier) return Number(earlier.id);
  const made = await importProject(coreApi, link, {
    title: String(link.name || `AlphaPulldown project ${link.project_number}`).slice(0, 200),
    description: `Moved from AlphaPulldown (its project P${link.project_number}). ${marker(link)}`
  });
  const id = made.ok && made.data ? Number((made.data.project && made.data.project.id) || made.data.id) : 0;
  if (!id) throw new Error(`Science did not create the project: ${failure(made)}`);
  return id;
}

// The items of the rows matching `where` (a condition on project_id).
async function collectItems(conn, where, params) {
  const out = [];
  const targets = await conn.query(`SELECT id, owner_id, name, status, created_at FROM alphapulldown_targets WHERE ${where} ORDER BY id`, params);
  for (const t of targets) {
    out.push({ ownerId: Number(t.owner_id), createdAt: t.created_at, ...items.describeItem(items.ITEM_TYPES.target, Number(t.id), { name: t.name, status: t.status }) });
  }
  const msaRuns = await conn.query(`SELECT id, owner_id, state, created_at FROM alphapulldown_msa_runs WHERE ${where} ORDER BY id`, params);
  for (const r of msaRuns) {
    out.push({ ownerId: Number(r.owner_id), createdAt: r.created_at, ...items.describeItem(items.ITEM_TYPES.msaRun, Number(r.id), { status: r.state }) });
  }
  const cofoldRuns = await conn.query(`SELECT id, owner_id, cancelled_at, created_at FROM alphapulldown_cofold_runs WHERE ${where} ORDER BY id`, params);
  for (const r of cofoldRuns) {
    const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    const states = await conn.query('SELECT state, COUNT(*) AS n FROM alphapulldown_cofold_items WHERE run_id = ? GROUP BY state', [r.id]);
    for (const s of states) counts[cofold.stateGroup(s.state)] += Number(s.n);
    out.push({ ownerId: Number(r.owner_id), createdAt: r.created_at, ...items.describeItem(items.ITEM_TYPES.cofoldRun, Number(r.id), { status: items.cofoldState(!!r.cancelled_at, counts) }) });
  }
  return out;
}

const body = item => ({ item_type: item.type, item_id: String(item.id), title: item.title, status: item.status, link: items.LINK });

// Lists a moved project's targets and runs on its page, as the project's owner
// (who has write access to it).
async function listMovedItems(coreApi, conn, link) {
  for (const item of await collectItems(conn, 'project_id = ?', [link.id])) {
    const result = await coreApi.callModuleAsUser(link.owner_id, 'science', 'POST', `/external/projects/${Number(link.science_project_id)}/items`, { body: body(item) });
    if (!result.ok && !PERMANENT.includes(result.status)) throw new Error(`could not list ${item.type} ${item.id}: ${failure(result)}`);
  }
}

async function moveProjects(coreApi, conn, report) {
  const links = await conn.query('SELECT * FROM alphapulldown_projects WHERE science_project_id IS NULL OR items_pending = 1 ORDER BY id');
  for (const link of links) {
    try {
      if (!link.science_project_id) {
        link.science_project_id = await createProject(coreApi, link);
        await conn.query('UPDATE alphapulldown_projects SET science_project_id = ?, items_pending = 1 WHERE id = ? AND science_project_id IS NULL', [link.science_project_id, link.id]);
        report.moved += 1;
      }
      await listMovedItems(coreApi, conn, link);
      await conn.query('UPDATE alphapulldown_projects SET items_pending = 0 WHERE id = ?', [link.id]);
    } catch (err) {
      report.pending.push(`project ${link.id} (user ${link.owner_id}): ${err.message}`);
    }
  }
}

// Work whose old project is gone goes to "Project template".
async function listOrphans(coreApi, conn, report) {
  const orphans = await collectItems(conn, 'project_id NOT IN (SELECT id FROM alphapulldown_projects)', []);
  const byOwner = new Map();
  for (const item of orphans) byOwner.set(item.ownerId, (byOwner.get(item.ownerId) || []).concat(item));
  for (const [ownerId, owned] of byOwner) {
    for (let i = 0; i < owned.length; i += TEMPLATE_BATCH) {
      const part = owned.slice(i, i + TEMPLATE_BATCH);
      const result = await coreApi.callModuleAsUser(ownerId, 'science', 'POST', '/external/template/items', {
        body: { items: part.map(item => ({ ...body(item), created_by: ownerId, created_at: item.createdAt })) }
      });
      if (!result.ok) {
        report.pending.push(`${part.length} item(s) without a project (user ${ownerId}): ${failure(result)}`);
        continue;
      }
      report.template += Number(result.data && result.data.saved) || 0;
    }
  }
}

// One pass. Returns { moved, template, pending: [reasons] }.
async function moveOnce(coreApi) {
  const report = { moved: 0, template: 0, pending: [] };
  const conn = await coreApi.pool.getConnection();
  try {
    await moveProjects(coreApi, conn, report);
    await listOrphans(coreApi, conn, report);
  } finally {
    conn.release();
  }
  return report;
}

// Starts the move in the background (the server may not be listening yet while
// modules register) and tries again, less and less often, until nothing is
// left or MAX_RETRIES is reached.
function start(coreApi, { log = console, schedule = setTimeout } = {}) {
  if (typeof coreApi.callModuleAsUser !== 'function') {
    log.warn('[alphapulldown] old projects cannot be moved to Science: this core has no callModuleAsUser.');
    return;
  }
  let attempt = 0;
  let lastPending = '';
  const later = delay => {
    const timer = schedule(run, delay);
    if (timer && timer.unref) timer.unref();
  };
  async function run() {
    let pending;
    try {
      const report = await moveOnce(coreApi);
      if (report.moved > 0 || report.template > 0) log.log(`[alphapulldown] moved to Science: ${report.moved} project(s); ${report.template} item(s) without a project listed in Project template.`);
      pending = report.pending.join('; ');
    } catch (err) {
      pending = err.message;
    }
    if (!pending) return;
    // The same reasons are not logged over and over.
    if (pending !== lastPending) log.warn(`[alphapulldown] still to be moved to Science: ${pending}`);
    lastPending = pending;
    if (attempt >= MAX_RETRIES) {
      log.warn('[alphapulldown] the move to Science stops trying until the module next starts.');
      return;
    }
    later(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
    attempt += 1;
  }
  later(FIRST_DELAY_MS);
}

module.exports = { collectItems, moveOnce, start };
