// Operations Cost Plan 2027 – db store: seed fallback, debounced per-field writes, read-only mode.
// No DOM or window access: receives `db` / `user` objects, runs in Node tests and in the page.

const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = ({ updatedAt, updatedBy, ...rest }) => rest;

// a dead listener is resubscribed after this backoff (attempt 0, 1, …), reset when it delivers again
const backoff = (attempt) => Math.min(15000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
// listener errors after which a fresh onSnapshot cannot help: read-only for the rest of the visit
const TERMINAL = new Set(['revoked', 'invalid_argument', 'transform_error', 'not_granted', 'capability_disabled', 'capability_removed']);
const LOST = 'Connection to the plan lost, reconnecting…';

export function createStore({ db, user, seed, debounceMs = 600, retryMs = () => 150 + Math.random() * 350, resubscribeMs = backoff }) {
  const subs = new Set();
  const holder = `store-${Math.random().toString(36).slice(2)}`; // lease holder for seeding
  let disposed = false, timer = null, chain = Promise.resolve(), busy = 0, seeded = false;
  // Edits are accepted only when the viewer may write (permitted), no terminal error has happened, and every
  // listener has delivered its first snapshot (synced): before that the page would show and build on the seed.
  let permitted = false, terminal = false, status = 'idle', error;
  const listeners = []; // {arrived, dead, unsub, timer, attempt}: one per db listener
  const synced = () => listeners.every((l) => l.arrived);
  const stopped = () => terminal || disposed || !permitted; // no writes at all
  const isReadOnly = () => stopped() || !synced(); // no new edits
  let dbInputs = null, dbMeta = null, dbRoles = null; // last db snapshots (null = missing)
  let localRoles = clone(seed.roles); // roles while the db has no plan yet
  const fresh = () => ({ scalars: {}, monthly: {} });
  let pending = fresh(); // edits not yet queued
  const layers = []; // one overlay per queued or in-flight batch, removed by its own job
  const roleLayers = []; // one apply fn per queued or in-flight role edit, removed when its write settles
  let planWaiters = [];
  let state;

  const inputsFrom = (...over) => {
    const inputs = clone(seed.inputs);
    for (const l of [dbInputs || {}, ...over]) {
      for (const s of inputs.scalars) if (l.scalars && l.scalars[s.key] !== undefined) s.value = l.scalars[s.key];
      for (const n of Object.keys(inputs.monthly)) if (l.monthly && Array.isArray(l.monthly[n])) inputs.monthly[n] = clone(l.monthly[n]);
    }
    return inputs;
  };
  const recompute = () => {
    state = {
      inputs: inputsFrom(...layers, pending),
      roles: roleLayers.reduce((l, apply) => apply(l), dbInputs && dbRoles ? dbRoles : localRoles),
      departments: dbMeta?.departments || seed.departments,
      readOnly: isReadOnly(), source: dbInputs ? 'db' : 'seed',
      // while a listener is dead the page shows its error, whatever a save that finishes meanwhile says
      ...(listeners.some((l) => l.dead) ? { status: 'error', error: LOST } : { status, ...(error ? { error } : {}) }),
    };
    for (const fn of [...subs]) fn(state);
  };

  // a plan exists only when plan/inputs has a body with scalars (a bare or empty doc does not count)
  const isPlan = (snap) => snap.exists && !!snap.data()?.scalars && typeof snap.data().scalars === 'object';

  // --- writes: one global queue, so each document sees one write at a time
  const stamp = async () => {
    let by = null;
    try { by = (await user?.id()) ?? null; } catch { /* no id */ }
    return { updatedAt: new Date().toISOString(), updatedBy: by };
  };
  async function send(fn) {
    try { return await fn(); } catch (e) {
      if (e?.code !== 'unavailable') throw e;
      await sleep(retryMs());
      return fn();
    }
  }
  function enqueue(job, batch, done) {
    if (stopped()) return;
    if (batch) layers.push(batch);
    busy++; status = 'saving'; error = undefined; recompute();
    chain = chain.then(() => (stopped() ? undefined : job())).catch((e) => {
      status = 'error'; error = e?.message || String(e?.code || e);
      if (e?.code === 'invalid_argument' || e?.code === 'revoked') { terminal = true; clearTimeout(timer); timer = null; pending = fresh(); }
    }).then(() => {
      if (batch) layers.splice(layers.indexOf(batch), 1); // drop only this batch's overlay
      done?.();
      busy--;
      if (!busy && !timer && status === 'saving') status = 'saved';
      recompute();
    });
  }
  // Seed the empty db under a lease on plan/seedLock (never on plan/inputs: a granted acquire may create its doc), so concurrent first editors cannot overwrite each other.
  async function seedIfNeeded() {
    if (dbInputs || seeded) return 'exists';
    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = db.doc('plan/inputs');
      const lease = await send(() => db.doc('plan/seedLock').acquire({ holder, ttlMs: 30000 }));
      if (lease.acquired) {
        if (isPlan(await send(() => ref.get()))) { seeded = true; return 'exists'; }
        const st = await stamp();
        const values = inputsFrom(...layers, pending);
        for (const r of localRoles) await send(() => db.doc(`roles/${r.id}`).set({ ...r, ...st }));
        await send(() => db.doc('plan/meta').set({ departments: seed.departments, ...st }));
        await send(() => ref.set({
          monthly: values.monthly, scalars: Object.fromEntries(values.scalars.map((s) => [s.key, s.value])), ...st,
        }));
        seeded = true;
        return 'seeded';
      }
      // busy: someone else is seeding; wait for their plan to appear, or re-check after the lease expires
      const exp = Date.parse(lease.expiresAt);
      const wait = Number.isFinite(exp) ? Math.max(0, exp - Date.now()) + 50 : 1000;
      await new Promise((resolve) => { planWaiters.push(resolve); sleep(wait).then(resolve); });
      if (dbInputs) { seeded = true; return 'exists'; }
    }
    throw new Error('Could not seed the plan: another editor holds it');
  }
  function flushInputs() {
    timer = null;
    if (!Object.keys(pending.scalars).length && !Object.keys(pending.monthly).length) return;
    if (stopped()) { pending = fresh(); return; }
    const batch = pending; pending = fresh();
    enqueue(async () => {
      if ((await seedIfNeeded()) === 'seeded') return;
      const st = await stamp();
      const data = { ...st };
      if (Object.keys(batch.scalars).length) data.scalars = batch.scalars;
      if (Object.keys(batch.monthly).length) data.monthly = batch.monthly;
      await send(() => db.doc('plan/inputs').update(data));
    }, batch);
  }
  const queueEdit = (fn) => {
    if (isReadOnly()) return;
    fn();
    clearTimeout(timer);
    timer = setTimeout(flushInputs, debounceMs);
    status = 'saving'; error = undefined; recompute();
  };

  // --- edits (the store is the write boundary: null clears a field, other non-finite values are rejected)
  const okValue = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
  function setScalar(key, value) {
    if (!okValue(value) || !seed.inputs.scalars.some((s) => s.key === key)) return;
    queueEdit(() => { pending.scalars[key] = value; });
  }
  function setMonthly(name, index, value) {
    if (isReadOnly() || !okValue(value) || !state.inputs.monthly[name] || !Number.isInteger(index) || index < 0 || index > 11) return;
    const arr = clone(state.inputs.monthly[name]);
    arr[index] = value;
    queueEdit(() => { pending.monthly[name] = arr; });
  }
  // The edit shows at once (local roles before the plan exists, else an overlay on the db roles until its
  // write settles), so a second edit of the same role, made before the snapshot returns, builds on the first.
  function roleEdit(apply, write) {
    if (isReadOnly()) return;
    let layer = null;
    if (!dbInputs && !seeded) localRoles = apply(localRoles);
    else roleLayers.push((layer = apply));
    recompute();
    enqueue(async () => { if ((await seedIfNeeded()) !== 'seeded') await write(); }, null,
      () => { if (layer) roleLayers.splice(roleLayers.indexOf(layer), 1); });
  }
  // Only the fields that differ from the role as shown are the edit (the overlay and the write carry just those),
  // so another editor's change to a different field of the same role still shows, and the write, made when its
  // turn comes, sets that field over the latest db version of the role instead of the copy the edit started from.
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  function upsertRole(role) {
    if (isReadOnly()) return;
    const r = clone(role);
    const cur = state.roles.find((x) => x.id === r.id);
    const patch = cur ? Object.fromEntries(Object.entries(r).filter(([k, v]) => !same(cur[k], v))) : r;
    if (!Object.keys(patch).length) return; // nothing changed: no write
    roleEdit(
      (l) => (l.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? { ...x, ...patch } : x)) : [...l, { ...r }]),
      async () => {
        const base = (dbRoles || []).find((x) => x.id === r.id) ?? r;
        const st = await stamp();
        await send(() => db.doc(`roles/${r.id}`).set({ ...base, ...patch, id: r.id, ...st }));
      });
  }
  function deleteRole(id) {
    roleEdit((l) => l.filter((x) => x.id !== id), () => send(() => db.doc(`roles/${id}`).delete()));
  }

  // --- subscriptions
  let markSynced;
  const syncedOnce = new Promise((resolve) => { markSynced = resolve; });
  const checkSynced = () => { if (synced() || terminal || disposed) markSynced(); };
  // One listener: arrived turns true with its first snapshot (a missing doc, exists:false, counts). A terminal
  // error ends editing for the visit; any other (the dead-bridge `unavailable`, unknown codes) kills only this
  // listener, so it is resubscribed after a backoff and the store is read-only until the fresh one delivers.
  const listen = (makeRef, onData) => {
    const l = { arrived: false, dead: false, unsub: null, timer: null, attempt: 0 };
    listeners.push(l);
    const start = () => {
      l.timer = null;
      if (disposed || terminal) return;
      l.arrived = false;
      l.unsub = makeRef().onSnapshot((s) => {
        l.arrived = true; l.dead = false; l.attempt = 0;
        onData(s); checkSynced(); recompute();
      }, (e) => {
        l.unsub = null; l.arrived = false;
        if (TERMINAL.has(e?.code)) { terminal = true; status = 'error'; error = e?.message || 'Database error'; checkSynced(); }
        else if (!disposed) { l.dead = true; l.timer = setTimeout(start, resubscribeMs(l.attempt++)); }
        recompute();
      });
    };
    start();
  };
  if (db) {
    listen(() => db.doc('plan/inputs'), (s) => { dbInputs = isPlan(s) ? s.data() : null; if (dbInputs) { planWaiters.forEach((w) => w()); planWaiters = []; } });
    listen(() => db.doc('plan/meta'), (s) => { dbMeta = s.exists ? s.data() : null; });
    listen(() => db.collection('roles'), (s) => { dbRoles = s.docs.map((d) => ({ ...strip(d.data()), id: d.id })); });
  }
  // resolves once the write permission is known and the first snapshots have arrived (or a terminal error)
  const ready = (async () => {
    let can = null;
    if (!db) return;
    try { can = user ? await user.can('data.write') : null; } catch { /* unknown */ }
    permitted = can !== false;
    recompute();
    await syncedOnce;
  })();
  recompute();

  return {
    ready,
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setScalar, setMonthly, upsertRole, deleteRole,
    dispose() {
      disposed = true; clearTimeout(timer);
      for (const l of listeners) { clearTimeout(l.timer); l.unsub?.(); }
      subs.clear(); checkSynced();
    },
  };
}
