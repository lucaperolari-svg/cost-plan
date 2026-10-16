// Page wiring: store from the bundled seed, capabilities when they resolve, tabs, status, Download Excel.
// Tab renderers (Tasks 6–9) register with mountTab(name, renderFn); renderFn receives
// {el, name, getState, subscribe, actions, capabilities} and may return a cleanup function.
// The panel element receives a 'tabshow' event each time its tab is selected.
import inputsSeed from '../../data/inputs.json';
import personnelSeed from '../../data/personnel.json';
import { createStore } from '../store.js';
import { calculate } from '../calc.js';
import { buildSheets, exportXlsx } from '../export.js';
import { renderSummary, destroySummary } from './summary.js';
import { renderInputs, destroyInputs } from './inputs.js';
import { renderPersonnel, destroyPersonnel } from './personnel.js';
import { renderReadme } from './readme.js';

const TABS = ['summary', 'inputs', 'personnel', 'readme'];
const TAB_KEY = 'ocp2027.tab';
const clone = (v) => JSON.parse(JSON.stringify(v));
const seed = () => ({ inputs: clone(inputsSeed), roles: clone(personnelSeed.roles), departments: clone(personnelSeed.departments) });
const $ = (id) => document.getElementById(id);
// cap on waiting for db/user/permission before showing the page as View only (tests may shorten it)
const CONNECT_TIMEOUT_MS = Number(window.__OCP_CONNECT_TIMEOUT_MS) > 0 ? Number(window.__OCP_CONNECT_TIMEOUT_MS) : 10000;

// --- store and capabilities
const subs = new Set();
let store = null, unsubStore = null;
let connecting = !!window.claude; // until db/user resolve, the store knows the write permission and the first snapshots arrived
const caps = { db: null, user: null, downloads: null };
let downloading = false;
let notice = null, noticeTimer = null; // brief download feedback in the status area: {text, state}
const NOTICE_MS = 4000;
const XLSX_FILENAME = 'Operations_Cost_Plan_2027.xlsx';

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
  mountTab,
};

async function connect() {
  const c = window.claude;
  if (!c || typeof c.use !== 'function') return;
  const use = (name) => Promise.resolve().then(() => c.use(name)).catch(() => null);
  use('downloads').then((d) => { caps.downloads = d || null; renderDownload(); });
  // The db attaches as soon as it resolves; `user` may arrive later (or never), so the store gets a
  // proxy that waits for it. The store starts read-only and stays so until can() answers and the first
  // plan/inputs, plan/meta and roles snapshots have arrived (store.ready), so nobody edits the seed values.
  const userP = use('user').then((u) => (caps.user = u || null));
  const lazyUser = {
    can: async (p) => { const u = await userP; return u ? u.can(p) : null; },
    id: async () => { const u = await userP; return u ? u.id() : null; },
  };
  const attach = use('db').then(async (db) => {
    caps.db = db || null;
    if (!caps.db) return;
    useStore(createStore({ db: caps.db, user: lazyUser, seed: seed() }));
    try { await store.ready; } catch { /* store stays read-only */ }
  });
  // The cap only ends "Connecting…" (seed view, View only meanwhile); capabilities still attach when they arrive,
  // and the store stays read-only until its snapshots arrive, however long that takes.
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, CONNECT_TIMEOUT_MS); });
  try { await Promise.race([attach, timeout]); } finally {
    clearTimeout(timer);
    connecting = false;
    emit(store.getState());
  }
  await attach;
  emit(store.getState());
}

// --- header status
function renderStatus(state) {
  const badge = $('badge-view-only'), save = $('save-status');
  badge.hidden = connecting || !state.readOnly;
  let text = '', st = state.status;
  if (connecting) { text = 'Connecting…'; st = 'connecting'; }
  else if (st === 'saving') text = 'Saving…';
  else if (st === 'error') text = `Not saved: ${state.error || 'database error'}`;
  else if (notice) { text = notice.text; st = notice.state; } // download feedback outranks "Saved", never a save error
  else if (st === 'saved') text = 'Saved';
  save.textContent = text;
  save.dataset.state = st;
  save.hidden = !text;
}
function renderDownload() {
  const btn = $('download-excel');
  btn.hidden = !caps.downloads;
  btn.disabled = downloading;
}
function showNotice(text, state) {
  clearTimeout(noticeTimer);
  notice = text ? { text, state } : null;
  if (notice) noticeTimer = setTimeout(() => { notice = null; emit(store.getState()); }, NOTICE_MS);
  emit(store.getState());
}
// Excel export of the current state (including edits the store holds but has not finished saving).
async function downloadExcel() {
  if (downloading || !caps.downloads) return;
  downloading = true;
  renderDownload();
  try {
    const XLSX = window.XLSX;
    if (!XLSX) { showNotice("Excel library didn't load — reload the page", 'error'); return; }
    const { inputs, roles, departments } = app.getState();
    const outcome = await exportXlsx({ XLSX, downloads: caps.downloads, sheets: buildSheets(inputs, roles, departments), filename: XLSX_FILENAME });
    if (outcome === 'saved' || outcome === 'delivered') showNotice('Excel downloaded', 'saved');
    else if (outcome === 'unavailable') showNotice('Download not available', 'error');
    else showNotice('', null); // declined: the person chose not to save
  } catch (e) {
    console.error(e);
    showNotice('Download failed', 'error');
  } finally {
    downloading = false;
    renderDownload();
  }
}
$('download-excel').addEventListener('click', downloadExcel);

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
mountTab('summary', ({ el, getState, subscribe }) => {
  const render = (state) => renderSummary(el, calculate(state.inputs, state.roles, state.departments));
  render(getState());
  const unsubscribe = subscribe(render);
  return () => { unsubscribe(); destroySummary(el); };
});
mountTab('inputs', ({ el, getState, subscribe, actions }) => {
  const render = (state) => renderInputs(el, state, actions);
  render(getState());
  const unsubscribe = subscribe(render);
  return () => { unsubscribe(); destroyInputs(el); };
});
mountTab('personnel', ({ el, getState, subscribe, actions }) => {
  const render = (state) => renderPersonnel(el, state, actions);
  render(getState());
  const unsubscribe = subscribe(render);
  return () => { unsubscribe(); destroyPersonnel(el); };
});
mountTab('readme', ({ el }) => renderReadme(el));
const hash = location.hash.slice(1), saved = tabMemory.get();
selectTab(TABS.includes(hash) ? hash : TABS.includes(saved) ? saved : 'summary', { remember: false });
window.__app = app;
connect().catch((e) => { console.error(e); connecting = false; emit(store.getState()); });
