// Operations Cost Plan 2027 – db store: seed fallback, debounced per-field writes, read-only mode.
// No DOM or window access: receives `db` / `user` objects, runs in Node tests and in the page.

const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = ({ updatedAt, updatedBy, ...rest }) => rest;

export function createStore({ db, user, seed, debounceMs = 600, retryMs = () => 150 + Math.random() * 350 }) {
  const subs = new Set();
  let disposed = false, timer = null, chain = Promise.resolve(), busy = 0, seeded = false;
  let readOnly = true, status = 'idle', error;
  let dbInputs = null, dbMeta = null, dbRoles = null; // last db snapshots (null = missing)
  let localRoles = clone(seed.roles); // roles while the db has no plan yet
  const fresh = () => ({ scalars: {}, monthly: {} });
  let pending = fresh(), inflight = fresh();
  let state;

  const isSeed = () => !dbInputs && !seeded;
  const inputsFrom = (...layers) => {
    const inputs = clone(seed.inputs);
    const base = dbInputs || {};
    for (const l of [base, ...layers]) {
      for (const s of inputs.scalars) if (l.scalars && l.scalars[s.key] !== undefined) s.value = l.scalars[s.key];
      for (const n of Object.keys(inputs.monthly)) if (l.monthly && Array.isArray(l.monthly[n])) inputs.monthly[n] = clone(l.monthly[n]);
    }
    return inputs;
  };
  const recompute = () => {
    state = {
      inputs: inputsFrom(inflight, pending),
      roles: dbInputs && dbRoles ? dbRoles : localRoles,
      departments: dbMeta?.departments || seed.departments,
      readOnly, source: dbInputs ? 'db' : 'seed', status,
      ...(error ? { error } : {}),
    };
    for (const fn of [...subs]) fn(state);
  };

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
  function enqueue(job) {
    if (readOnly || disposed) return;
    busy++; status = 'saving'; error = undefined; recompute();
    chain = chain.then(job).catch((e) => {
      status = 'error'; error = e?.message || String(e?.code || e);
      if (e?.code === 'invalid_argument' || e?.code === 'revoked') readOnly = true;
      clearTimeout(timer); timer = null; pending = fresh();
    }).then(() => {
      inflight = fresh(); busy--;
      if (!busy && !timer && status === 'saving') status = 'saved';
      recompute();
    });
  }
  async function seedAll(roles) {
    const st = await stamp();
    const values = inputsFrom(inflight, pending);
    for (const r of roles) await send(() => db.doc(`roles/${r.id}`).set({ ...r, ...st }));
    await send(() => db.doc('plan/meta').set({ departments: seed.departments, ...st }));
    await send(() => db.doc('plan/inputs').set({
      monthly: values.monthly, scalars: Object.fromEntries(values.scalars.map((s) => [s.key, s.value])), ...st,
    }));
    seeded = true;
  }
  function flushInputs() {
    timer = null;
    if (!Object.keys(pending.scalars).length && !Object.keys(pending.monthly).length) return;
    const batch = pending; pending = fresh(); inflight = batch;
    enqueue(async () => {
      if (isSeed()) return seedAll(localRoles);
      const st = await stamp();
      const data = { ...st };
      if (Object.keys(batch.scalars).length) data.scalars = batch.scalars;
      if (Object.keys(batch.monthly).length) data.monthly = batch.monthly;
      await send(() => db.doc('plan/inputs').update(data));
    });
  }
  const queueEdit = (fn) => {
    if (readOnly || disposed) return false;
    fn();
    clearTimeout(timer);
    timer = setTimeout(flushInputs, debounceMs);
    status = 'saving'; error = undefined; recompute();
    return true;
  };

  // --- edits
  function setScalar(key, value) {
    if (!seed.inputs.scalars.some((s) => s.key === key)) return;
    queueEdit(() => { pending.scalars[key] = Number(value); });
  }
  function setMonthly(name, index, value) {
    if (!state.inputs.monthly[name]) return;
    const arr = clone(state.inputs.monthly[name]);
    arr[index] = Number(value);
    queueEdit(() => { pending.monthly[name] = arr; });
  }
  function roleEdit(apply, write) {
    if (readOnly || disposed) return;
    if (isSeed()) {
      localRoles = apply(localRoles);
      recompute();
      return enqueue(() => (isSeed() ? seedAll(localRoles) : write()));
    }
    enqueue(write);
  }
  function upsertRole(role) {
    const r = clone(role);
    roleEdit(
      (l) => (l.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? r : x)) : [...l, r]),
      async () => { const st = await stamp(); await send(() => db.doc(`roles/${r.id}`).set({ ...r, ...st })); });
  }
  function deleteRole(id) {
    roleEdit((l) => l.filter((x) => x.id !== id), () => send(() => db.doc(`roles/${id}`).delete()));
  }

  // --- subscriptions
  const unsubs = [];
  const onErr = (e) => { status = 'error'; error = e?.message || 'Database error'; if (e?.code === 'revoked') readOnly = true; recompute(); };
  if (db) {
    unsubs.push(db.doc('plan/inputs').onSnapshot((s) => { dbInputs = s.exists ? s.data() : null; recompute(); }, onErr));
    unsubs.push(db.doc('plan/meta').onSnapshot((s) => { dbMeta = s.exists ? s.data() : null; recompute(); }, onErr));
    unsubs.push(db.collection('roles').onSnapshot((s) => { dbRoles = s.docs.map((d) => ({ ...strip(d.data()), id: d.id })); recompute(); }, onErr));
  }
  const ready = (async () => {
    let can = null;
    if (!db) return;
    try { can = user ? await user.can('data.write') : null; } catch { /* unknown */ }
    readOnly = can === false;
    recompute();
  })();
  recompute();

  return {
    ready,
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setScalar, setMonthly, upsertRole, deleteRole,
    dispose() { disposed = true; clearTimeout(timer); unsubs.forEach((u) => u()); subs.clear(); },
  };
}
