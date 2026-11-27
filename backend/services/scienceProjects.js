// Projects belong to the Science module. This module never holds projects of
// its own: everything (targets, sequences, runs) belongs to a Science
// project, and core answers who may do what in it (coreApi.projects, which
// fails closed).
//
// The table alphapulldown_projects is only the LINK between this module's
// rows and a Science project: one row per (user, Science project), holding
// the number of that user's workspace folder (P<n>). Rows of other tables
// keep pointing at the link row, so nothing stored had to be rewritten when
// projects moved to Science. A link with no science_project_id is a project
// from before the move, still waiting to be moved.
const { httpError } = require('./httpError');

const NOT_MOVED = 'This work belongs to an old AlphaPulldown project that has not been moved into a Science project yet.';

const TEMPLATE_ONLY_OLD = 'Project template only holds older work - choose another project.';
const STAFF_ROLES = ['developer', 'administrator'];

function isStaff(user) {
  return ((user && user.roles) || []).some(role => STAFF_ROLES.includes(role));
}

// What core says about `user` in Science project `id`, as
// { id, number, title, archived, isTemplate, canRead, canWrite, reason }.
// Nothing is ever created or changed in the Project template or in an
// archived project, whatever the user's access to it.
async function projectAccess(coreApi, user, id) {
  if (!coreApi.projects) throw httpError(503, 'Projects are not available: this core is too old (0.1.218 or later is needed).');
  const wanted = Number(id);
  if (!Number.isSafeInteger(wanted) || wanted <= 0) throw httpError(404, 'Project not found');
  const answer = await coreApi.projects.access(user, wanted);
  if (!answer || !answer.ok) {
    // "No access" and "could not ask" must not look alike.
    if (!(await coreApi.projects.available())) throw httpError(503, 'Projects are not available (the Science module that provides them is not installed).');
    throw httpError(answer && answer.error ? 503 : 404, answer && answer.error ? `Could not check your access to the project: ${answer.error}` : 'Project not found');
  }
  if (!answer.can_read) throw httpError(404, 'Project not found');
  const project = answer.project || {};
  const archived = !!project.archived;
  const isTemplate = !!project.is_template;
  let reason = '';
  if (isTemplate) reason = TEMPLATE_ONLY_OLD;
  else if (archived) reason = 'This project is archived, so nothing in it can be changed or run.';
  else if (!answer.can_write) reason = 'You have read-only access to this project. Its owner can give you write access in Science.';
  return {
    id: wanted,
    number: project.number || '',
    title: project.title || `Project ${wanted}`,
    archived,
    isTemplate,
    canRead: true,
    canWrite: !!answer.can_write && !archived && !isTemplate,
    reason
  };
}

// The same, refusing (403 with the reason) when writing is needed and not
// allowed.
async function requireAccess(coreApi, user, id, { write = false } = {}) {
  const access = await projectAccess(coreApi, user, id);
  if (write && !access.canWrite) throw httpError(403, access.reason);
  return access;
}

// For something new that belongs to no particular project (adding a proteome
// to the shared library): the user needs a project of their own to work in.
// Staff look after the library and are not held to it.
async function requireSomeProject(coreApi, user) {
  if (isStaff(user)) return;
  if (!coreApi.projects || typeof coreApi.projects.hasWritableProject !== 'function') {
    throw httpError(503, 'Projects are not available: this core is too old (0.1.227 or later is needed).');
  }
  if (!(await coreApi.projects.hasWritableProject(user))) throw httpError(403, 'You need a project first: ask for one on the project tabs, or ask a project owner for write access.');
}

// The rows (a condition on project_id and owner_id) of work that has no
// Science project: its old project has not been moved, or is gone. It is shown
// under the Project template, to its owner and to staff only.
function oldWork(user) {
  const where = '(project_id NOT IN (SELECT id FROM alphapulldown_projects WHERE science_project_id IS NOT NULL))';
  return isStaff(user) ? { where, params: [] } : { where: `${where} AND owner_id = ?`, params: [user.id] };
}

async function linksFor(conn, scienceId) {
  return conn.query('SELECT * FROM alphapulldown_projects WHERE science_project_id = ? ORDER BY id', [scienceId]);
}

async function linkById(conn, id) {
  const rows = await conn.query('SELECT * FROM alphapulldown_projects WHERE id = ?', [id]);
  return rows[0] || null;
}

async function findLink(conn, scienceId, ownerId) {
  const rows = await conn.query('SELECT * FROM alphapulldown_projects WHERE science_project_id = ? AND owner_id = ? ORDER BY id LIMIT 1', [scienceId, ownerId]);
  return rows[0] || null;
}

// The user's link to a Science project, made on first use. project_number is
// the user's next workspace folder number; the unique key on (owner_id,
// project_number) turns two simultaneous first uses into one retry.
async function ensureLink(conn, access, ownerId) {
  for (let attempt = 0; ; attempt += 1) {
    const existing = await findLink(conn, access.id, ownerId);
    if (existing) return existing;
    try {
      await conn.query(
        `INSERT INTO alphapulldown_projects (owner_id, project_number, name, mode, science_project_id)
         SELECT ?, COALESCE(MAX(project_number), 0) + 1, ?, 'pulldown', ? FROM alphapulldown_projects WHERE owner_id = ?`,
        [ownerId, String(access.title).slice(0, 255), access.id, ownerId]
      );
    } catch (err) {
      if (attempt >= 2 || err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
}

// For the routes whose rows are the caller's own inside a project (sequences,
// feature and co-folding runs): checks the caller's access to the Science
// project named by :id and returns the caller's link row. Reading before the
// first write returns an empty stand-in (id 0 matches no row).
async function openOwnLink(coreApi, conn, req, { write = req.method !== 'GET' } = {}) {
  const access = await requireAccess(coreApi, req.user, req.params.id, { write });
  const link = write ? await ensureLink(conn, access, req.user.id) : await findLink(conn, access.id, req.user.id);
  const row = link || { id: 0, owner_id: req.user.id, project_number: 0, mode: 'pulldown', updated_at: null };
  return { ...row, name: access.title, science: access };
}

module.exports = { NOT_MOVED, isStaff, projectAccess, requireAccess, requireSomeProject, oldWork, linksFor, linkById, findLink, ensureLink, openOwnLink };
