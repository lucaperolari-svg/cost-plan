// Page wiring: store from the bundled seed, capabilities when they resolve, tabs, status, Download Excel.
// Tab renderers (Tasks 6–9) register with mountTab(name, renderFn); renderFn receives
// {el, name, getState, subscribe, actions, capabilities} and may return a cleanup function.
// The panel element receives a 'tabshow' event each time its tab is selected.
import inputsSeed from '../../data/inputs.json';
import personnelSeed from '../../data/personnel.json';
import { createStore } from '../store.js';

const TABS = ['summary', 'inputs', 'personnel', 'readme'];
const TAB_KEY = 'ocp2027.tab';
const clone = (v) => JSON.parse(JSON.stringify(v));
const seed = () => ({ inputs: clone(inputsSeed), roles: clone(personnelSeed.roles), departments: clone(personnelSeed.departments) });
const $ = (id) => document.getElementById(id);

// --- store and capabilities
const subs = new Set();
let store = null, unsubStore = null;
let connecting = !!window.claude; // until db/user resolve and the store knows the write permission
const caps = { db: null, user: null, downloads: null };
let downloadHandler = null;

function emit(state) {
  renderStatus(state);
  for (const fn of [...subs]) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}
function useStore(next) {
  unsubStore?.();
  store?.dispose();
  store = next;
  unsubStore = store.subscribe(emit);
  emit(store.getState());
}

export const app = {
  getState: () => store.getState(),
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  actions: {
    setScalar: (...a) => store.setScalar(...a),
    setMonthly: (...a) => store.setMonthly(...a),
    upsertRole: (...a) => store.upsertRole(...a),
    deleteRole: (...a) => store.deleteRole(...a),
  },
  capabilities: () => ({ ...caps }),
  onDownload(fn) { downloadHandler = fn; renderDownload(); },
  mountTab,
};

async function connect() {
  const c = window.claude;
  if (!c || typeof c.use !== 'function') return;
  const use = (name) => Promise.resolve().then(() => c.use(name)).catch(() => null);
  use('downloads').then((d) => { caps.downloads = d || null; renderDownload(); });
  const [db, user] = await Promise.all([use('db'), use('user')]);
  caps.db = db || null;
  caps.user = user || null;
  if (caps.db) {
    useStore(createStore({ db: caps.db, user: caps.user, seed: seed() }));
    try { await store.ready; } catch { /* store stays read-only */ }
  }
  connecting = false;
  emit(store.getState());
}

// --- header status
function renderStatus(state) {
  const badge = $('badge-view-only'), save = $('save-status');
  badge.hidden = connecting || !state.readOnly;
  let text = '', st = state.status;
  if (connecting) { text = 'Connecting…'; st = 'connecting'; }
  else if (st === 'saving') text = 'Saving…';
  else if (st === 'saved') text = 'Saved';
  else if (st === 'error') text = `Not saved: ${state.error || 'database error'}`;
  save.textContent = text;
  save.dataset.state = st;
  save.hidden = !text;
}
function renderDownload() {
  const btn = $('download-excel');
  btn.hidden = !caps.downloads;
  btn.disabled = !downloadHandler;
}
$('download-excel').addEventListener('click', async () => {
  if (!downloadHandler || !caps.downloads) return;
  const btn = $('download-excel');
  btn.disabled = true;
  try { await downloadHandler({ getState: app.getState, downloads: caps.downloads }); } catch (e) { console.error(e); } finally { btn.disabled = false; }
});

// --- tabs
const tabEl = (name) => $(`tab-${name}`);
const panelEl = (name) => $(`panel-${name}`);
const tabMemory = {
  get() { try { return localStorage.getItem(TAB_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(TAB_KEY, v); } catch { /* storage unavailable */ } },
};
function selectTab(name, { focus = false, remember = true } = {}) {
  for (const t of TABS) {
    const on = t === name;
    tabEl(t).setAttribute('aria-selected', String(on));
    tabEl(t).tabIndex = on ? 0 : -1;
    panelEl(t).hidden = !on;
  }
  if (focus) tabEl(name).focus();
  if (remember) tabMemory.set(name);
  panelEl(name).dispatchEvent(new CustomEvent('tabshow'));
}
const tablist = document.querySelector('[role=tablist]');
tablist.addEventListener('click', (e) => {
  const tab = e.target.closest('[role=tab]');
  if (tab) selectTab(tab.id.slice(4));
});
tablist.addEventListener('keydown', (e) => {
  const tab = e.target.closest('[role=tab]');
  if (!tab) return;
  const i = TABS.indexOf(tab.id.slice(4));
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  selectTab(TABS[(to + TABS.length) % TABS.length], { focus: true });
});

// --- tab renderers
const cleanups = new Map();
export function mountTab(name, renderFn) {
  const el = panelEl(name);
  if (!el) throw new Error(`Unknown tab: ${name}`);
  const prev = cleanups.get(name);
  if (typeof prev === 'function') prev();
  el.replaceChildren();
  try {
    cleanups.set(name, renderFn({ el, name, getState: app.getState, subscribe: app.subscribe, actions: app.actions, capabilities: app.capabilities }));
  } catch (e) {
    console.error(e);
    el.textContent = 'This section could not be displayed. Reload the page to try again.';
  }
}

// --- start: render from the seed now, light features up as capabilities resolve
useStore(createStore({ db: null, user: null, seed: seed() }));
renderDownload();
const hash = location.hash.slice(1), saved = tabMemory.get();
selectTab(TABS.includes(hash) ? hash : TABS.includes(saved) ? saved : 'summary', { remember: false });
window.__app = app;
connect().catch((e) => { console.error(e); connecting = false; emit(store.getState()); });
