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

// Science as the move sees it. `disabled` users are refused by core.
function fakeCore(data, { disabled = [], failItems = false } = {}) {
  const science = { projects: [], items: [], template: [] };
  const core = {
    science,
    failItems,
    pool: { getConnection: async () => fakeDb(data) },
    callModuleAsUser: async (userId, moduleId, method, path, opts = {}) => {
      assert.strictEqual(moduleId, 'science');
      if (disabled.includes(userId)) return { ok: false, status: 0, data: null, error: 'refused', refused: true, reason: 'user_unavailable' };
      if (method === 'GET' && path === '/external/projects') return { ok: true, status: 200, data: science.projects.filter(p => p.owner === userId) };
      if (method === 'POST' && path === '/external/projects') {
        const project = { id: 100 + science.projects.length, owner: userId, ...opts.body };
        science.projects.push(project);
        return { ok: true, status: 201, data: project };
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
