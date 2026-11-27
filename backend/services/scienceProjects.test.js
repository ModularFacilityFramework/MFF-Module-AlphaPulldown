const test = require('node:test');
const assert = require('node:assert');
const science = require('./scienceProjects');
const items = require('./projectItems');

const USER = { id: 7, roles: [] };

function coreWith(answer, available = true) {
  return { projects: { access: async () => answer, available: async () => available } };
}

function answer(overrides = {}) {
  return {
    ok: true, can_read: true, can_write: true, can_manage: false, access: 'write',
    project: { id: 4, number: 'P-0004', title: 'Kinases', archived: false }, error: null, ...overrides
  };
}

const status = code => err => err.status === code;

test('write access allows changing, and the project is described', async () => {
  const access = await science.requireAccess(coreWith(answer()), USER, '4', { write: true });
  assert.deepStrictEqual(access, { id: 4, number: 'P-0004', title: 'Kinases', archived: false, canRead: true, canWrite: true, reason: '' });
});

test('read-only access reads but cannot change, and says why', async () => {
  const core = coreWith(answer({ can_write: false, access: 'read' }));
  const access = await science.requireAccess(core, USER, 4);
  assert.strictEqual(access.canWrite, false);
  assert.match(access.reason, /read-only/);
  await assert.rejects(science.requireAccess(core, USER, 4, { write: true }), err => err.status === 403 && /read-only/.test(err.message));
});

test('an archived project is read-only even for its owner', async () => {
  const core = coreWith(answer({ access: 'owner', project: { id: 4, number: 'P-0004', title: 'Kinases', archived: true } }));
  await assert.rejects(science.requireAccess(core, USER, 4, { write: true }), err => err.status === 403 && /archived/.test(err.message));
  assert.strictEqual((await science.requireAccess(core, USER, 4)).canWrite, false);
});

test('no access is 404; a provider that is missing or failing is 503', async () => {
  const none = answer({ ok: true, can_read: false, can_write: false, access: 'none', project: null });
  await assert.rejects(science.requireAccess(coreWith(none), USER, 4), status(404));
  await assert.rejects(science.requireAccess(coreWith({ ok: false, error: null }, false), USER, 4), status(503));
  await assert.rejects(science.requireAccess(coreWith({ ok: false, error: 'database down' }), USER, 4), status(503));
  await assert.rejects(science.requireAccess({}, USER, 4), status(503));
  await assert.rejects(science.requireAccess(coreWith(answer()), USER, 'abc'), status(404));
});

// Just enough of alphapulldown_projects for the link queries.
function fakeLinks(rows = []) {
  return {
    rows,
    query: async (sql, params) => {
      if (/^SELECT \* FROM alphapulldown_projects WHERE science_project_id = \? AND owner_id/.test(sql)) {
        return rows.filter(r => r.science_project_id === params[0] && r.owner_id === params[1]).slice(0, 1);
      }
      if (/INSERT INTO alphapulldown_projects/.test(sql)) {
        const [ownerId, name, scienceId] = params;
        const number = Math.max(0, ...rows.filter(r => r.owner_id === ownerId).map(r => r.project_number)) + 1;
        rows.push({ id: rows.length + 1, owner_id: ownerId, project_number: number, name, science_project_id: scienceId });
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected query ${sql}`);
    }
  };
}

test('a link is made once per user and Science project, with the next folder number', async () => {
  const conn = fakeLinks([{ id: 1, owner_id: 7, project_number: 3, name: 'old', science_project_id: 2 }]);
  const access = { id: 4, title: 'Kinases' };
  const first = await science.ensureLink(conn, access, 7);
  const again = await science.ensureLink(conn, access, 7);
  assert.strictEqual(first.id, again.id);
  assert.strictEqual(first.project_number, 4);
  assert.strictEqual((await science.ensureLink(conn, access, 8)).project_number, 1);
  assert.strictEqual(conn.rows.length, 3);
});

test('reading never makes a link; a writer\'s first change does', async () => {
  const conn = fakeLinks();
  const read = await science.openOwnLink(coreWith(answer()), conn, { method: 'GET', params: { id: '4' }, user: USER });
  assert.strictEqual(read.id, 0);
  assert.strictEqual(read.name, 'Kinases');
  assert.strictEqual(conn.rows.length, 0);
  const wrote = await science.openOwnLink(coreWith(answer()), conn, { method: 'POST', params: { id: '4' }, user: USER });
  assert.strictEqual(wrote.id, 1);
  assert.strictEqual(wrote.science.id, 4);
  const readOnly = coreWith(answer({ can_write: false }));
  await assert.rejects(science.openOwnLink(readOnly, conn, { method: 'DELETE', params: { id: '4' }, user: USER }), status(403));
});

test('items are registered on the project through Science, as the user', async () => {
  const calls = [];
  const core = { callModule: async (...args) => { calls.push(args); return { ok: true, status: 200, data: {} }; } };
  const req = { headers: { authorization: 'Bearer t' } };
  assert.strictEqual(await items.registerItem(core, req, 4, { type: 'target', id: 12, title: 'Target: X', status: 'draft' }), '');
  assert.deepStrictEqual(calls[0], ['Bearer t', 'science', 'POST', '/external/projects/4/items',
    { body: { item_type: 'target', item_id: '12', title: 'Target: X', status: 'draft', link: '/dashboard?tab=alphapulldown' } }]);
  await items.removeItem(core, req, 4, 'target', 12);
  assert.deepStrictEqual(calls[1].slice(1), ['science', 'DELETE', '/external/projects/4/items/target/12']);
});

test('a failing Science call is reported, never thrown', async () => {
  const req = { headers: {} };
  const refused = { callModule: async () => ({ ok: false, status: 409, data: { error: 'Project is archived' }, error: null }) };
  assert.match(await items.registerItem(refused, req, 4, { type: 'target', id: 1, title: 't' }), /Project is archived/);
  const broken = { callModule: async () => { throw new Error('boom'); } };
  assert.match(await items.registerItem(broken, req, 4, { type: 'target', id: 1, title: 't' }), /boom/);
  // already gone is not a failure
  const gone = { callModule: async () => ({ ok: false, status: 404, data: {}, error: null }) };
  assert.strictEqual(await items.removeItem(gone, req, 4, 'target', 1), '');
});
