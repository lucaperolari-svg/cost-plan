// In-memory test double of the artifact `db` capability. Plain browser-safe ES:
// no Node imports, only Promise/setTimeout/Date, so page tests can inject it too.
// Faithful on: own writes visible at once (hasPendingWrites) and reverted if rejected,
// frozen snapshot data, onSnapshot error callbacks, acquire leases, configurable write delay, and an
// optional delay before each subscription's first snapshot (a slow network: nothing is delivered before it).

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const merge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) dst[k] = isObj(v) && isObj(dst[k]) ? merge(dst[k], v) : clone(v);
  return dst;
};
const parent = (path) => path.slice(0, path.lastIndexOf('/'));
const later = (fn) => Promise.resolve().then(fn);

export function fakeDb({ writeDelay = 0, snapshotDelay = 0 } = {}) {
  const docs = new Map(); // path -> body (includes this client's unconfirmed writes)
  const pendingCount = new Map(); // path -> unconfirmed own writes
  const leases = new Map(); // path -> {holder, expires}
  const docSubs = new Set(); // {path, next, error, live}
  const colSubs = new Set();
  const writes = []; // this client's writes: {op, path, data?}
  const remoteWrites = [];
  let failNext = null;
  let delay = writeDelay;
  let firstDelay = snapshotDelay;

  const meta = (path) => ({ fromCache: false, hasPendingWrites: (pendingCount.get(path) || 0) > 0 });
  const snap = (path) => {
    const body = docs.has(path) ? freeze(clone(docs.get(path))) : undefined;
    return { id: path.split('/').pop(), exists: body !== undefined, data: () => body, metadata: meta(path) };
  };
  const colSnap = (path) => {
    const list = [...docs.keys()].filter((p) => parent(p) === path).sort().map(snap);
    return { docs: list, size: list.length, empty: !list.length, metadata: { fromCache: false, hasPendingWrites: list.some((d) => d.metadata.hasPendingWrites) } };
  };
  // a listener gets changes only after its first snapshot (which already carries the current state)
  const notify = (path) => {
    for (const s of docSubs) if (s.path === path && s.started) later(() => s.live && s.next(snap(path)));
    for (const s of colSubs) if (s.path === parent(path) && s.started) later(() => s.live && s.next(colSnap(s.path)));
  };
  const apply = (op, path, data) => {
    if (op === 'set') docs.set(path, clone(data));
    else if (op === 'update') merge(docs.get(path), data);
    else docs.delete(path);
    notify(path);
  };
  const bump = (path, n) => pendingCount.set(path, (pendingCount.get(path) || 0) + n);
  const write = (op, path, data) => {
    writes.push(data === undefined ? { op, path } : { op, path, data: clone(data) });
    if (op === 'update' && !docs.has(path)) return later(() => Promise.reject({ code: 'invalid_argument', message: 'no such document' }));
    const had = docs.has(path), prev = had ? clone(docs.get(path)) : undefined;
    const fail = failNext; failNext = null;
    apply(op, path, data); bump(path, 1); // visible at once, unconfirmed
    return new Promise((resolve, reject) => {
      const done = () => {
        bump(path, -1);
        if (fail) { if (had) docs.set(path, prev); else docs.delete(path); reject({ code: fail, message: fail }); } else resolve();
        notify(path);
      };
      if (delay > 0) setTimeout(done, delay); else later(done);
    });
  };
  const subscribe = (set, path, view, next, error) => {
    const s = { path, next, error, live: true, started: false };
    set.add(s);
    const first = () => { if (!s.live) return; s.started = true; next(view(path)); };
    if (firstDelay > 0) setTimeout(first, firstDelay); else later(first);
    return () => { s.live = false; set.delete(s); };
  };
  const docRef = (path) => ({
    id: path.split('/').pop(), path,
    get: () => later(() => snap(path)),
    set: (d) => write('set', path, d),
    update: (d) => write('update', path, d),
    delete: () => write('delete', path),
    acquire: ({ holder, ttlMs = 30000, data }) => later(() => {
      const l = leases.get(path), now = Date.now();
      if (l && l.expires > now && l.holder !== holder) return { acquired: false, expiresAt: new Date(l.expires).toISOString() };
      const expires = now + Math.min(Math.max(ttlMs, 1000), 600000);
      leases.set(path, { holder, expires });
      if (data) docs.set(path, merge(docs.get(path) || {}, data));
      else if (!docs.has(path)) docs.set(path, {}); // like the real one may: a granted acquire can create the leased doc
      notify(path);
      return { acquired: true, holder, expiresAt: new Date(expires).toISOString() };
    }),
    onSnapshot: (next, error) => subscribe(docSubs, path, snap, next, error),
  });
  const colRef = (path) => ({
    path,
    doc: (id) => docRef(`${path}/${id}`),
    get: () => later(() => colSnap(path)),
    onSnapshot: (next, error) => subscribe(colSubs, path, colSnap, next, error),
  });

  return {
    doc: docRef,
    collection: colRef,
    writes,
    remoteWrites,
    docs, // raw state, for assertions
    setWriteDelay: (ms) => { delay = ms; },
    setSnapshotDelay: (ms) => { firstDelay = ms; }, // delay before the first snapshot of later subscriptions
    subscriptions: () => docSubs.size + colSubs.size, // live listeners
    failNext: (code) => { failNext = code; }, // next write is rejected with {code} (and reverted)
    failSubscriptions: (code) => { // terminate every listener with an error
      for (const set of [docSubs, colSubs]) for (const s of [...set]) { s.live = false; set.delete(s); s.error?.({ code, message: code }); }
    },
    remote: (op, path, data) => { remoteWrites.push({ op, path, data }); return later(() => apply(op, path, data)); }, // write as another client
  };
}
