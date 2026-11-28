const test = require('node:test');
const assert = require('node:assert');
const move = require('./scienceMove');

// Just enough of the tables for the move's queries.
function fakeDb(data) {
  const exists = id => data.links.some(l => l.id === id);
  const query = async (sql, params = []) => {
    if (/^SELECT \* FROM alphapulldown_projects WHERE science_project_id IS NULL/.test(sql)) {
      return data.links.filter(l => !l.science_project_id || l.items_pending).map(l => ({ ...l }));
    }
    if (/SET science_project_id = \?, items_pending = 1/.test(sql)) {
      Object.assign(data.links.find(l => l.id === params[1]), { science_project_id: params[0], items_pending: 1 });
      return {};
    }
    if (/SET items_pending = 0/.test(sql)) {
      data.links.find(l => l.id === params[0]).items_pending = 0;
      return {};
    }
    const table = ['targets', 'msa_runs', 'cofold_runs'].find(t => sql.includes(`FROM alphapulldown_${t} WHERE`));
    if (table) return (data[table] || []).filter(r => (/NOT IN/.test(sql) ? !exists(r.project_id) : r.project_id === params[0]));
    if (/FROM alphapulldown_cofold_items/.test(sql)) return [{ state: 'COMPLETED', n: 2 }];
    throw new Error(`unexpected query ${sql}`);
  };
  return { query, release: () => {} };
}

// Science as the move sees it. `disabled` users are refused by core;
// `mayNotCreate` users are refused by the ordinary creating route only;
// `noImportRoute` is a Science older than the import route.
function fakeCore(data, { disabled = [], failItems = false, mayNotCreate = [], noImportRoute = false } = {}) {
  const science = { projects: [], items: [], template: [], imports: new Map(), calls: [] };
  const create = (userId, body) => {
    const project = { id: 100 + science.projects.length, owner: userId, ...body };
    science.projects.push(project);
    return project;
  };
  const core = {
    science,
    failItems,
    pool: { getConnection: async () => fakeDb(data) },
    callModuleAsUser: async (userId, moduleId, method, path, opts = {}) => {
      assert.strictEqual(moduleId, 'science');
      if (disabled.includes(userId)) return { ok: false, status: 0, data: null, error: 'refused', refused: true, reason: 'user_unavailable' };
      if (method === 'GET' && path === '/external/projects') return { ok: true, status: 200, data: science.projects.filter(p => p.owner === userId) };
      if (method === 'POST') science.calls.push(path);
      if (method === 'POST' && path === '/external/project-imports') {
        if (noImportRoute) return { ok: false, status: 404, data: null, error: null };
        const { old_id: oldId, title, description } = opts.body;
        assert.strictEqual(typeof oldId, 'string');
        const earlier = science.imports.get(oldId);
        if (earlier && earlier.user !== userId) return { ok: false, status: 409, data: { error: 'imported for another user' }, error: null };
        const id = earlier ? earlier.id : create(userId, { title, description }).id;
        science.imports.set(oldId, { id, user: userId });
        return { ok: true, status: earlier ? 200 : 201, data: { created: !earlier, project: { id, number: `P-${id}` }, access: 'owner', can_read: true, can_write: true, can_manage: true } };
      }
      if (method === 'POST' && path === '/external/projects') {
        if (mayNotCreate.includes(userId)) return { ok: false, status: 403, data: { error: 'You cannot create a project' }, error: null };
        return { ok: true, status: 201, data: create(userId, opts.body) };
      }
      if (path === '/external/template/items') {
        science.template.push(...opts.body.items);
        return { ok: true, status: 201, data: { saved: opts.body.items.length, skipped: [] } };
      }
      const match = /^\/external\/projects\/(\d+)\/items$/.exec(path);
      assert.ok(match, `unexpected call ${method} ${path}`);
      if (core.failItems) return { ok: false, status: 500, data: { error: 'down' }, error: null };
      science.items.push({ project: Number(match[1]), by: userId, ...opts.body });
      return { ok: true, status: 201, data: { success: true } };
    }
  };
  return core;
}

function sample() {
  return {
    links: [
      { id: 1, owner_id: 7, project_number: 1, name: 'Kinases', science_project_id: null, items_pending: 0 },
      { id: 2, owner_id: 9, project_number: 1, name: 'Gone owner', science_project_id: null, items_pending: 0 }
    ],
    targets: [{ id: 5, project_id: 1, owner_id: 7, name: 'PknB', status: 'confirmed', created_at: '2026-11-01T10:00:00Z' }],
    msa_runs: [
      { id: 3, project_id: 1, owner_id: 7, state: 'COMPLETED', created_at: '2026-11-02T10:00:00Z' },
      { id: 4, project_id: 99, owner_id: 7, state: 'FAILED', created_at: '2026-10-02T10:00:00Z' }
    ],
    cofold_runs: [{ id: 8, project_id: 1, owner_id: 7, cancelled_at: null, created_at: '2026-11-03T10:00:00Z' }]
  };
}

test('old projects become their owner\'s Science projects with their targets and runs', async () => {
  const data = sample();
  const core = fakeCore(data, { disabled: [9] });
  const report = await move.moveOnce(core);
  assert.strictEqual(report.moved, 1);
  assert.deepStrictEqual(core.science.projects.map(p => [p.owner, p.title]), [[7, 'Kinases']]);
  assert.strictEqual(data.links[0].science_project_id, 100);
  assert.strictEqual(data.links[0].items_pending, 0);
  assert.deepStrictEqual(core.science.items.map(i => [i.project, i.by, i.item_type, i.item_id, i.status]), [
    [100, 7, 'target', '5', 'confirmed'],
    [100, 7, 'msa_run', '3', 'COMPLETED'],
    [100, 7, 'cofold_run', '8', 'finished']
  ]);
  // the owner who cannot sign in is left as it was, with the reason
  assert.strictEqual(data.links[1].science_project_id, null);
  assert.match(report.pending.join(), /project 2 \(user 9\).*user_unavailable/);
  // the run whose project is gone goes to Project template, in its owner's name
  assert.strictEqual(report.template, 1);
  assert.deepStrictEqual(core.science.template.map(i => [i.item_type, i.item_id, i.created_by]), [['msa_run', '4', 7]]);
});

test('an owner who may not create projects is moved through the import route', async () => {
  const data = sample();
  const core = fakeCore(data, { mayNotCreate: [7, 9] });
  const report = await move.moveOnce(core);
  assert.deepStrictEqual(report.pending, []);
  assert.strictEqual(report.moved, 2);
  assert.deepStrictEqual([...core.science.imports.keys()], ['1', '2']);
  assert.ok(!core.science.calls.includes('/external/projects'));
  assert.match(core.science.projects[0].description, /\[AlphaPulldown project 1\]$/);
});

test('on a Science without the import route the ordinary route is used', async () => {
  const data = sample();
  const core = fakeCore(data, { noImportRoute: true, mayNotCreate: [9] });
  const report = await move.moveOnce(core);
  assert.strictEqual(report.moved, 1);
  assert.deepStrictEqual(core.science.projects.map(p => p.owner), [7]);
  assert.match(report.pending.join(), /project 2 \(user 9\).*You cannot create a project/);
});

test('an import Science already has is answered with the same project', async () => {
  const data = sample();
  data.links.pop();
  const core = fakeCore(data);
  // imported before an interruption, and no longer among the owner's projects
  core.science.imports.set('1', { id: 77, user: 7 });
  await move.moveOnce(core);
  assert.strictEqual(core.science.projects.length, 0);
  assert.strictEqual(data.links[0].science_project_id, 77);
});

test('a refused import is not retried through the ordinary route', async () => {
  const data = sample();
  data.links.pop();
  const core = fakeCore(data);
  core.science.imports.set('1', { id: 77, user: 8 });
  const report = await move.moveOnce(core);
  assert.ok(!core.science.calls.includes('/external/projects'));
  assert.strictEqual(data.links[0].science_project_id, null);
  assert.match(report.pending.join(), /imported for another user/);
});

test('a second pass makes nothing twice', async () => {
  const data = sample();
  const core = fakeCore(data);
  await move.moveOnce(core);
  const again = await move.moveOnce(core);
  assert.strictEqual(again.moved, 0);
  assert.strictEqual(core.science.projects.length, 2);
  assert.strictEqual(core.science.items.length, 3);
});

test('a project made just before an interruption is found again by its mark', async () => {
  const data = sample();
  data.links.pop();
  const core = fakeCore(data);
  core.science.projects.push({ id: 55, owner: 7, title: 'Kinases', description: 'Moved from AlphaPulldown (its project P1). [AlphaPulldown project 1]' });
  await move.moveOnce(core);
  assert.strictEqual(core.science.projects.length, 1);
  assert.strictEqual(data.links[0].science_project_id, 55);
});

test('items that could not be listed are tried again without a second project', async () => {
  const data = sample();
  data.links.pop();
  const core = fakeCore(data, { failItems: true });
  const first = await move.moveOnce(core);
  assert.strictEqual(data.links[0].items_pending, 1);
  assert.strictEqual(first.pending.length, 1);
  core.failItems = false;
  const second = await move.moveOnce(core);
  assert.deepStrictEqual(second.pending, []);
  assert.strictEqual(core.science.projects.length, 1);
  assert.strictEqual(core.science.items.length, 3);
});

test('the background start retries until nothing is left, then stops', async () => {
  const data = sample();
  const disabled = [9];
  const core = fakeCore(data, { disabled });
  const timers = [];
  const lines = [];
  move.start(core, { log: { log: l => lines.push(l), warn: l => lines.push(l) }, schedule: (fn, delay) => { timers.push({ fn, delay }); return null; } });
  assert.strictEqual(timers.length, 1);
  await timers.shift().fn();
  assert.strictEqual(timers.length, 1);
  await timers.shift().fn();
  assert.strictEqual(lines.filter(l => /still to be moved/.test(l)).length, 1);
  disabled.length = 0;
  await timers.shift().fn();
  assert.strictEqual(timers.length, 0);
});

test('what can never be moved is not retried for ever', async () => {
  const core = fakeCore(sample(), { disabled: [9] });
  const timers = [];
  const lines = [];
  move.start(core, { log: { log: () => {}, warn: l => lines.push(l) }, schedule: (fn, delay) => { timers.push({ fn, delay }); return null; } });
  let runs = 0;
  while (timers.length > 0 && runs < 50) {
    runs += 1;
    await timers.shift().fn();
  }
  assert.strictEqual(runs, 9); // the first try and 8 retries
  assert.match(lines[lines.length - 1], /until the module next starts/);
});
