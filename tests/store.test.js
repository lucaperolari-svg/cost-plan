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

// --- fix round 1: queued batches, failures, seeding race, bad values, faithful fake
async function drain(n = 12, ms = 300) { for (let i = 0; i < n; i++) { mock.timers.tick(ms); await settle(); } }
const seeded = async (opts) => { const x = await make(opts); x.store.setScalar('costOfContact', 1); await debounce(); return x; };

test('second batch queued while the first is in flight keeps every monthly edit', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await seeded();
  db.setWriteDelay(300);
  store.setMonthly('csLicences', 1, 111); await debounce(); // batch 1 in flight
  store.setMonthly('csLicences', 2, 222); await debounce(); // batch 2 queued
  assert.deepEqual(store.getState().inputs.monthly.csLicences.slice(1, 3), [111, 222]);
  mock.timers.tick(300); await settle(); // batch 1 done, batch 2 running
  assert.deepEqual(store.getState().inputs.monthly.csLicences.slice(1, 3), [111, 222]);
  store.setMonthly('csLicences', 3, 333); await debounce();
  await drain();
  assert.deepEqual(db.docs.get('plan/inputs').monthly.csLicences.slice(1, 4), [111, 222, 333]);
  assert.equal(store.getState().status, 'saved');
});

test('a remote change while a local edit is pending: local survives, other fields update', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await seeded();
  store.setScalar('aiCallShare', 0.5); // pending, not flushed
  await db.remote('update', 'plan/inputs', { scalars: { aiCallShare: 0.9, pricePerSms: 0.77 } });
  await settle();
  assert.equal(val(store, 'aiCallShare'), 0.5);
  assert.equal(val(store, 'pricePerSms'), 0.77);
});

test('two stores seeding an empty db at once: both edits survive, all roles written once', async (t) => {
  t.after(() => mock.timers.reset());
  const db = fakeDb();
  const a = await make({ db, u: user(true, 'u_a') });
  const b = await make({ db, u: user(true, 'u_b') });
  a.store.setScalar('aiCallShare', 0.5);
  b.store.setScalar('pricePerSms', 0.123);
  await debounce(); await drain(4);
  const sc = db.docs.get('plan/inputs').scalars;
  assert.equal(sc.aiCallShare, 0.5);
  assert.equal(sc.pricePerSms, 0.123);
  assert.equal([...db.docs.keys()].filter((p) => p.startsWith('roles/')).length, 13);
  assert.equal(writesTo(db, 'plan/inputs').filter((w) => w.op === 'set').length, 1);
  assert.equal(val(a.store, 'pricePerSms'), 0.123);
  assert.equal(val(b.store, 'aiCallShare'), 0.5);
});

test('a failed write drops only its own batch', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await seeded();
  db.setWriteDelay(300);
  db.failNext('resource_exhausted');
  store.setScalar('aiCallShare', 0.5); await debounce(); // in flight, will fail
  store.setScalar('costOfContact', 7); // pending, made after the failed batch was taken
  await debounce(); await drain();
  const sc = db.docs.get('plan/inputs').scalars;
  assert.notEqual(sc.aiCallShare, 0.5);
  assert.equal(sc.costOfContact, 7);
  assert.equal(val(store, 'costOfContact'), 7);
  assert.notEqual(val(store, 'aiCallShare'), 0.5);
  assert.equal(store.getState().readOnly, false);
});

test('a failed role write does not drop pending input edits', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await seeded();
  store.setScalar('aiCallShare', 0.5);
  db.failNext('resource_exhausted');
  store.upsertRole({ ...seed().roles[0], fte: 0.25 });
  await settle(); await debounce(); await drain(2);
  assert.equal(db.docs.get('plan/inputs').scalars.aiCallShare, 0.5);
});

test('no writes after invalid_argument, including queued and pending edits', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await seeded();
  db.setWriteDelay(300);
  db.failNext('invalid_argument');
  store.setScalar('aiCallShare', 0.5); await debounce();
  store.setScalar('costOfContact', 7); await debounce(); // queued behind the failing write
  store.setScalar('pricePerSms', 0.2); // pending
  const n = db.writes.length;
  await drain();
  assert.equal(store.getState().readOnly, true);
  assert.equal(store.getState().status, 'error');
  assert.equal(db.writes.length, n);
  store.setScalar('pricePerSms', 0.3); store.upsertRole(seed().roles[0]); store.deleteRole('R02');
  await debounce(); await drain(2);
  assert.equal(db.writes.length, n);
});

test('onSnapshot error callback: revoked shows an error and read-only', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await seeded();
  db.failSubscriptions('revoked');
  assert.equal(store.getState().status, 'error');
  assert.equal(store.getState().readOnly, true);
});

test('store is the write boundary: bad values and indexes are rejected', async (t) => {
  t.after(() => mock.timers.reset());
  const { db, store } = await seeded();
  const n = db.writes.length;
  const before = JSON.stringify(store.getState().inputs);
  for (const v of [NaN, Infinity, 'abc', '5', undefined, {}]) store.setScalar('pricePerSms', v);
  store.setMonthly('csLicences', 12, 1); store.setMonthly('csLicences', -1, 1); store.setMonthly('csLicences', 1.5, 1); store.setMonthly('csLicences', 0, NaN);
  store.setMonthly('nope', 0, 1);
  await debounce();
  assert.equal(db.writes.length, n);
  assert.equal(JSON.stringify(store.getState().inputs), before);
  store.setScalar('pricePerSms', null); // explicit clear is allowed
  await debounce();
  assert.equal(db.docs.get('plan/inputs').scalars.pricePerSms, null);
});
