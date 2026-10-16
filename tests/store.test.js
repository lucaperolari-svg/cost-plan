import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../src/store.js';
import { fakeDb } from './fake-db.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const seed = () => ({ inputs: read('inputs.json'), roles: read('personnel.json').roles, departments: read('personnel.json').departments });
const settle = () => new Promise((r) => setImmediate(r)); // flush microtasks; setImmediate is not mocked
const val = (st, key) => st.getState().inputs.scalars.find((s) => s.key === key).value;
const user = (can = true, id = 'u_1') => ({ can: async () => can, id: async () => id });

async function make({ db = fakeDb(), u = user(), ms = 600 } = {}) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStore({ db, user: u, seed: seed(), debounceMs: ms });
  await store.ready;
  await settle();
  return { db, store };
}
const writesTo = (db, path) => db.writes.filter((w) => w.path === path);
async function debounce(ms = 600) { mock.timers.tick(ms); await settle(); }

test('db null: seed, read-only, edits ignored', async () => {
  const store = createStore({ db: null, user: null, seed: seed() });
  await store.ready;
  const s = store.getState();
  assert.equal(s.readOnly, true);
  assert.equal(s.source, 'seed');
  assert.deepEqual(s.inputs, seed().inputs);
  store.setScalar('aiCallShare', 0.5);
  assert.deepEqual(store.getState().inputs, seed().inputs);
});

test('empty db, can true: seed source, editable; first edit seeds the whole plan with set', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  assert.equal(store.getState().readOnly, false);
  assert.equal(store.getState().source, 'seed');
  store.setScalar('aiCallShare', 0.5);
  assert.equal(val(store, 'aiCallShare'), 0.5);
  assert.equal(db.writes.length, 0);
  await debounce();
  const s = seed();
  const inp = writesTo(db, 'plan/inputs');
  assert.equal(inp.length, 1);
  assert.equal(inp[0].op, 'set');
  assert.equal(inp[0].data.scalars.aiCallShare, 0.5);
  assert.equal(Object.keys(inp[0].data.scalars).length, s.inputs.scalars.length);
  assert.deepEqual(inp[0].data.monthly, s.inputs.monthly);
  assert.equal(inp[0].data.updatedBy, 'u_1');
  assert.match(inp[0].data.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(writesTo(db, 'plan/meta')[0].op, 'set');
  assert.deepEqual(writesTo(db, 'plan/meta')[0].data.departments, s.departments);
  const rw = db.writes.filter((w) => w.path.startsWith('roles/'));
  assert.equal(rw.length, s.roles.length);
  assert.ok(rw.every((w) => w.op === 'set'));
  assert.equal(store.getState().source, 'db');
  assert.equal(store.getState().status, 'saved');
  store.setScalar('costOfContact', 1);
  await debounce();
  assert.equal(writesTo(db, 'plan/inputs')[1].op, 'update');
});

test('first role edit while seed seeds all roles, not just one', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  const r = { ...seed().roles[0], fte: 0.5 };
  store.upsertRole(r);
  await settle(); await debounce();
  const ids = [...db.docs.keys()].filter((p) => p.startsWith('roles/'));
  assert.equal(ids.length, seed().roles.length);
  assert.equal(db.docs.get('roles/R01').fte, 0.5);
  assert.ok(db.docs.has('plan/inputs'));
  assert.equal(store.getState().roles.length, seed().roles.length);
});

test('can false: read-only and no writes', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make({ u: user(false) });
  assert.equal(store.getState().readOnly, true);
  store.setScalar('aiCallShare', 0.5);
  store.setMonthly('newCustomers', 0, 5);
  store.upsertRole(seed().roles[0]);
  store.deleteRole('R01');
  await debounce(); await settle();
  assert.equal(db.writes.length, 0);
  assert.equal(val(store, 'aiCallShare'), seed().inputs.scalars.find((s) => s.key === 'aiCallShare').value);
});

test('can null: stays editable', async (t) => {
  t.after(() => mock.timers.reset());
  const { store } = await make({ u: user(null) });
  assert.equal(store.getState().readOnly, false);
});

test('burst within debounce: one update with both keys; other editor change survives', async (t) => {
  t.after(() => mock.timers.reset());
  const db = fakeDb();
  const a = await make({ db });
  a.store.setScalar('costOfContact', 1);
  await debounce(); // seeds plan
  const b = await make({ db });
  a.store.setScalar('aiCallShare', 0.5);
  mock.timers.tick(300);
  a.store.setScalar('costOfContact', 2);
  await b.store.ready;
  b.store.setScalar('pricePerSms', 0.123);
  await debounce(); // flushes both stores (shared mock clock)
  const upA = writesTo(db, 'plan/inputs').filter((w) => w.op === 'update' && w.data.scalars.aiCallShare !== undefined);
  assert.equal(upA.length, 1);
  assert.deepEqual(Object.keys(upA[0].data.scalars).sort(), ['aiCallShare', 'costOfContact']);
  const final = db.docs.get('plan/inputs').scalars;
  assert.equal(final.pricePerSms, 0.123);
  assert.equal(final.aiCallShare, 0.5);
  assert.equal(final.costOfContact, 2);
  assert.equal(val(a.store, 'pricePerSms'), 0.123); // arrived via snapshot
});

test('monthly edit replaces only that array', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  store.setScalar('costOfContact', 1);
  await debounce();
  store.setMonthly('csLicences', 2, 99);
  await debounce();
  const w = writesTo(db, 'plan/inputs').at(-1);
  assert.equal(w.op, 'update');
  assert.deepEqual(Object.keys(w.data.monthly), ['csLicences']);
  assert.equal(w.data.monthly.csLicences[2], 99);
  assert.equal(w.data.monthly.csLicences.length, 12);
});

test('remote snapshot changes inputs and notifies subscribers', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  store.setScalar('costOfContact', 1);
  await debounce();
  let calls = 0;
  const off = store.subscribe(() => calls++);
  await db.remote('update', 'plan/inputs', { scalars: { pricePerSms: 0.5 } });
  await settle();
  assert.equal(val(store, 'pricePerSms'), 0.5);
  assert.ok(calls >= 1);
  const before = calls;
  off();
  await db.remote('update', 'plan/inputs', { scalars: { pricePerSms: 0.6 } });
  await settle();
  assert.equal(calls, before);
  // metadata still comes from the seed
  const sc = store.getState().inputs.scalars.find((s) => s.key === 'pricePerSms');
  assert.ok(sc.label && sc.unit);
});

test('remote roles and departments are used once plan exists', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  store.setScalar('costOfContact', 1);
  await debounce();
  await db.remote('delete', 'roles/R02');
  await db.remote('set', 'roles/R99', { ...seed().roles[0], id: 'R99' });
  await settle();
  const ids = store.getState().roles.map((r) => r.id);
  assert.ok(!ids.includes('R02') && ids.includes('R99'));
});

test('update rejecting invalid_argument switches to read-only with error', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  store.setScalar('costOfContact', 1);
  await debounce();
  db.failNext('invalid_argument');
  store.setScalar('aiCallShare', 0.5);
  await debounce();
  const s = store.getState();
  assert.equal(s.readOnly, true);
  assert.equal(s.status, 'error');
  assert.ok(s.error);
});

test('unavailable retries once', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  store.setScalar('costOfContact', 1);
  await debounce();
  const n = writesTo(db, 'plan/inputs').length;
  db.failNext('unavailable');
  store.setScalar('aiCallShare', 0.5);
  await debounce();
  mock.timers.tick(1000); await settle();
  assert.equal(writesTo(db, 'plan/inputs').length, n + 2);
  assert.equal(store.getState().status, 'saved');
  assert.equal(store.getState().readOnly, false);
  assert.equal(db.docs.get('plan/inputs').scalars.aiCallShare, 0.5);
});

test('upsertRole sets roles/{id}; deleteRole deletes', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  store.setScalar('costOfContact', 1);
  await debounce();
  const n = db.writes.length;
  store.upsertRole({ ...seed().roles[0], fte: 0.25 });
  await settle();
  assert.deepEqual(db.writes.slice(n).map((w) => [w.op, w.path]), [['set', 'roles/R01']]);
  assert.equal(db.writes[n].data.fte, 0.25);
  assert.equal(db.writes[n].data.updatedBy, 'u_1');
  await settle();
  assert.equal(store.getState().roles.find((r) => r.id === 'R01').fte, 0.25);
  store.deleteRole('R03');
  await settle();
  assert.deepEqual(db.writes.at(-1), { op: 'delete', path: 'roles/R03' });
  assert.ok(!store.getState().roles.some((r) => r.id === 'R03'));
});

test('dispose stops listening', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await make();
  store.setScalar('costOfContact', 1);
  await debounce();
  store.dispose();
  await db.remote('update', 'plan/inputs', { scalars: { pricePerSms: 0.9 } });
  await settle();
  assert.notEqual(val(store, 'pricePerSms'), 0.9);
});
