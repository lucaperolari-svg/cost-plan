// In-memory test double of the artifact `db` capability. Plain browser-safe ES:
// no Node imports, only Promise/setTimeout, so page tests can inject it too.

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const merge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) dst[k] = isObj(v) && isObj(dst[k]) ? merge(dst[k], v) : clone(v);
  return dst;
};
const parent = (path) => path.slice(0, path.lastIndexOf('/'));
const later = (fn) => Promise.resolve().then(fn);

export function fakeDb() {
  const docs = new Map(); // path -> body
  const docSubs = new Set(); // {path, next}
  const colSubs = new Set(); // {path, next}
  const writes = []; // this client's writes: {op, path, data?}
  const remoteWrites = [];
  let failNext = null;

  const snap = (path) => {
    const body = docs.get(path);
    return { id: path.split('/').pop(), exists: body !== undefined, data: () => (body === undefined ? undefined : clone(body)), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const colSnap = (path) => {
    const list = [...docs.keys()].filter((p) => parent(p) === path).sort().map(snap);
    return { docs: list, size: list.length, empty: !list.length, metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const notify = (path) => {
    for (const s of docSubs) if (s.path === path && s.live) later(() => s.live && s.next(snap(path)));
    for (const s of colSubs) if (s.path === parent(path) && s.live) later(() => s.live && s.next(colSnap(s.path)));
  };
  const apply = (op, path, data) => {
    if (op === 'set') docs.set(path, clone(data));
    else if (op === 'update') {
      if (!docs.has(path)) return Promise.reject({ code: 'invalid_argument', message: 'no such document' });
      merge(docs.get(path), data);
    } else docs.delete(path);
    notify(path);
  };
  const write = (op, path, data) => {
    writes.push(data === undefined ? { op, path } : { op, path, data: clone(data) });
    return later(() => {
      if (failNext) { const f = failNext; failNext = null; return Promise.reject({ code: f, message: f }); }
      return apply(op, path, data);
    });
  };
  const subscribe = (set, path, view, next) => {
    const s = { path, next, live: true };
    set.add(s);
    later(() => s.live && next(view(path)));
    return () => { s.live = false; set.delete(s); };
  };
  const docRef = (path) => ({
    id: path.split('/').pop(), path,
    get: () => later(() => snap(path)),
    set: (d) => write('set', path, d),
    update: (d) => write('update', path, d),
    delete: () => write('delete', path),
    onSnapshot: (next) => subscribe(docSubs, path, snap, next),
  });
  const colRef = (path) => ({
    path,
    doc: (id) => docRef(`${path}/${id}`),
    get: () => later(() => colSnap(path)),
    onSnapshot: (next) => subscribe(colSubs, path, colSnap, next),
  });

  return {
    doc: docRef,
    collection: colRef,
    writes,
    remoteWrites,
    docs, // raw state, for assertions
    failNext: (code) => { failNext = code; }, // next write rejects with {code}
    remote: (op, path, data) => { remoteWrites.push({ op, path, data }); return later(() => apply(op, path, data)); }, // write as another client
  };
}
