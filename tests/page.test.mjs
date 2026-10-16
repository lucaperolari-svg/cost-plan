// Playwright page tests for dist/index.html. Run with `npm run test:page` (builds first).
// Harness: openPage({claude, cdn, colorScheme, viewport}) -> page (with page.errors).
//   claude: undefined -> no window.claude at all.
//           {db, user, downloads, delayMs, script} -> window.claude.use(name) stub:
//             db: true | {writeDelay, docs: {path: body}} -> fakeDb() from tests/fake-db.js, null -> resolves null
//             user: {can, id, isOwner, canEdit} (can = can('data.write') result) | null
//             downloads: true -> records saves in window.__test.saves, null -> resolves null
//             delayMs: delay before every use() resolves (default 20; never synchronous)
//             script: extra JS source run after the stub is set up (window.__test holds db/user/downloads)
//   cdn: 'stub' (default: cdnjs scripts answer with an empty script, fonts with empty CSS) | 'fail' (requests aborted)
//        | {url: body} overrides for specific cdnjs URLs.
// The published page is a fragment (the platform wraps it in a skeleton), so the harness wraps it the same way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const CHART = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const XLSX = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const SKELETON = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>
${body}
</body></html>`;

const pageFile = `${root}dist/.page-under-test.html`;
const fakeDbSource = readFileSync(`${root}tests/fake-db.js`, 'utf8').replace(/^export /m, '');
let browser;

before(async () => {
  writeFileSync(pageFile, SKELETON(readFileSync(`${root}dist/index.html`, 'utf8')));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

function claudeStub(opts) {
  // runs in the page before any page script
  return `(() => {
    ${fakeDbSource}
    const o = ${JSON.stringify(opts)};
    const T = (window.__test = { saves: [] });
    if (o.db) {
      T.db = fakeDb({ writeDelay: o.db.writeDelay || 0 });
      for (const [p, body] of Object.entries(o.db.docs || {})) T.db.docs.set(p, body);
    }
    if (o.user) {
      const u = o.user;
      T.user = Object.freeze({
        can: async () => (u.can === undefined ? null : u.can),
        id: async () => u.id ?? null,
        isOwner: async () => !!u.isOwner,
        canEdit: async () => !!u.canEdit,
        me: async () => ({ id: u.id ?? null, name: u.name || '', email: null }),
      });
    }
    if (o.downloads) T.downloads = Object.freeze({ save: async (req) => { T.saves.push(req); return { status: 'saved' }; } });
    const resolveLater = (v) => new Promise((r) => setTimeout(() => r(v), o.delayMs ?? 20));
    window.claude = Object.freeze({ use: (name) => resolveLater(T[name] ?? null) });
    ${opts.script || ''}
  })();`;
}

export async function openPage({ claude, cdn = 'stub', colorScheme = 'light', viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ colorScheme, viewport });
  const page = await context.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (cdn === 'fail') return route.abort();
    if (typeof cdn === 'object' && cdn[url] !== undefined) return route.fulfill({ contentType: 'text/javascript', body: cdn[url] });
    if (url.startsWith('https://cdnjs.cloudflare.com/')) return route.fulfill({ contentType: 'text/javascript', body: '/* stub */' });
    if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ contentType: 'text/css', body: '' });
    page.errors.push(`unexpected request: ${url}`);
    return route.abort();
  });
  if (claude) await page.addInitScript(claudeStub(claude));
  page.close = ((close) => async () => { await close(); await context.close(); })(page.close.bind(page));
  await page.goto(pathToFileURL(pageFile).href);
  return page;
}

const tabNames = (page) => page.$$eval('[role=tab]', (els) => els.map((e) => e.textContent.trim()));

test('no window.claude: four tabs, View only, no errors, only the two cdnjs scripts', async () => {
  const page = await openPage();
  assert.deepEqual(await tabNames(page), ['Summary', 'Inputs', 'Personnel', 'Read Me']);
  await page.getByText('View only', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.title(), 'Operations Cost Plan 2027');
  const srcs = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean));
  assert.deepEqual(srcs.sort(), [CHART, XLSX].sort());
  assert.equal(await page.isHidden('#download-excel'), true);
  await page.waitForTimeout(100);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('tabs: aria wiring, arrow keys move selection, selection is remembered', async () => {
  const page = await openPage();
  const selected = () => page.$eval('[role=tab][aria-selected=true]', (e) => e.textContent.trim());
  assert.equal(await selected(), 'Summary');
  const wiring = await page.$$eval('[role=tab]', (tabs) => tabs.map((t) => {
    const p = document.getElementById(t.getAttribute('aria-controls'));
    return p && p.getAttribute('role') === 'tabpanel' && p.getAttribute('aria-labelledby') === t.id;
  }));
  assert.deepEqual(wiring, [true, true, true, true]);
  await page.focus('[role=tab][aria-selected=true]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await selected(), 'Inputs');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Inputs');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await selected(), 'Read Me');
  await page.keyboard.press('Home');
  assert.equal(await selected(), 'Summary');
  await page.getByRole('tab', { name: 'Personnel' }).click();
  assert.equal(await page.isVisible('#panel-personnel'), true);
  assert.equal(await page.isHidden('#panel-summary'), true);
  await page.reload();
  assert.equal(await selected(), 'Personnel');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('editor with db, user and downloads: no View only badge, Download Excel shown', async () => {
  const page = await openPage({ claude: { db: true, user: { can: true, id: 'u1' }, downloads: true } });
  await page.waitForSelector('#download-excel', { state: 'visible' });
  await page.waitForFunction(() => document.getElementById('badge-view-only')?.hidden === true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('viewer (can false) and null capabilities: View only, Download Excel hidden', async () => {
  for (const claude of [{ db: true, user: { can: false } }, { db: null, user: null, downloads: null }]) {
    const page = await openPage({ claude });
    await page.waitForTimeout(150);
    assert.equal(await page.isVisible('#badge-view-only'), true);
    assert.equal(await page.isHidden('#download-excel'), true);
    assert.deepEqual(page.errors, []);
    await page.close();
  }
});

test('mountTab renderers get the panel and live state', async () => {
  const page = await openPage({ claude: { script: '' } });
  const out = await page.evaluate(() => new Promise((resolve) => {
    window.__app.mountTab('summary', ({ el, getState, subscribe }) => {
      el.textContent = `roles:${getState().roles.length}`;
      subscribe((s) => { el.dataset.source = s.source; });
      resolve(el.id);
    });
  }));
  assert.equal(out, 'panel-summary');
  assert.match(await page.textContent('#panel-summary'), /^roles:\d+$/);
  await page.close();
});

test('page still renders when the CDNs fail', async () => {
  const page = await openPage({ cdn: 'fail' });
  assert.deepEqual(await tabNames(page), ['Summary', 'Inputs', 'Personnel', 'Read Me']);
  assert.equal(await page.isVisible('#badge-view-only'), true);
  assert.deepEqual(page.errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e)), []);
  await page.close();
});

test('375 px, light and dark: 16 px gutter, no page-level horizontal scroll', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await openPage({ colorScheme, viewport: { width: 375, height: 800 } });
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      bg: getComputedStyle(document.body).backgroundColor,
      left: Math.round(document.querySelector('[role=tablist]').getBoundingClientRect().left),
    }));
    assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
    assert.ok(m.left >= 16, `tablist left ${m.left}`);
    assert.notEqual(m.bg, 'rgba(0, 0, 0, 0)');
    await page.close();
  }
});

// --- Summary tab (Task 6)
const summaryText = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());

test('summary: headline tiles show v5 totals, Dec CTS average and marginal, fixed share', async () => {
  const page = await openPage();
  await page.waitForSelector('#panel-summary .tile');
  const tiles = await page.$$eval('#panel-summary .tile', (els) => els.map((e) => ({
    label: e.querySelector('.tile-label').textContent.trim(),
    value: e.querySelector('.tile-value').textContent.trim(),
    context: e.querySelector('.tile-context')?.textContent.trim() || '',
  })));
  assert.equal(tiles.length, 4);
  assert.equal(tiles[0].value, '€1,216,931');
  assert.match(tiles[1].label, /December CTS per POD per year.*average/);
  assert.equal(tiles[1].value, '€641.32');
  assert.match(tiles[2].label, /marginal \(variable only\)/);
  assert.equal(tiles[2].value, '€124.46');
  assert.equal(tiles[3].value, '93.9%');
  assert.match(tiles[3].context, /€1,142,807/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('summary: table has 46 data rows, total row, bucket and F/V tags on line rows', async () => {
  const page = await openPage();
  await page.waitForSelector('#panel-summary table');
  assert.equal(await page.$$eval('#panel-summary tbody tr[data-row]', (r) => r.length), 46);
  assert.ok(await page.$$eval('#panel-summary tbody tr:not([data-row])', (r) => r.length) >= 10, 'section header rows');
  const total = await page.$eval('#panel-summary tr[data-row="r47"]', (tr) => ({
    label: tr.cells[0].textContent.trim(), last: tr.cells[tr.cells.length - 1].textContent.trim(),
  }));
  assert.deepEqual(total, { label: 'TOTAL OPERATIONS COST', last: '1,216,931' });
  const lines = await page.$$eval('#panel-summary tr[data-kind="line"]', (rows) => rows.map((tr) => ({
    row: tr.dataset.row,
    tags: [...tr.querySelectorAll('.tag')].map((t) => t.dataset.value),
  })));
  assert.equal(lines.length, 24); // 4+3+6+2+4 cost lines + 5 departments
  for (const l of lines) assert.equal(l.tags.length, 2, `${l.row} tags`);
  assert.deepEqual(lines.find((l) => l.row === 'r06').tags, ['CTS - Operations', 'Variable']);
  assert.deepEqual(lines.find((l) => l.row === 'r43').tags, ['Outside CTS', 'Fixed']);
  assert.equal(await page.$$eval('#panel-summary tr[data-kind="subtotal"] .tag', (t) => t.length), 0);
  // formats: eurPerPod 2 decimals, fte 2 decimals, count 0 decimals
  const lastCell = (r) => page.$eval(`#panel-summary tr[data-row="${r}"]`, (tr) => tr.cells[tr.cells.length - 1].textContent.trim());
  assert.equal(await lastCell('r69'), '1,854.40');
  assert.equal(await lastCell('r66'), '11.75');
  assert.equal(await lastCell('r64'), '583');
  assert.equal(await page.$eval('#panel-summary tr[data-row="r69"]', (tr) => tr.cells[tr.cells.length - 2].textContent.trim()), '641.32');
  // no Chart.js (CDN stubbed): no canvas, no errors
  assert.equal(await page.$$eval('#panel-summary canvas', (c) => c.length), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('summary at 375 px, light and dark: no page-level horizontal scroll, table scrolls in its wrapper', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await openPage({ colorScheme, viewport: { width: 375, height: 800 } });
    await page.waitForSelector('#panel-summary table');
    const m = await page.evaluate(() => {
      const wrap = document.querySelector('#panel-summary .table-scroll');
      return {
        sw: document.documentElement.scrollWidth,
        wrapScrolls: wrap.scrollWidth > wrap.clientWidth,
        overflow: getComputedStyle(wrap).overflowX,
        sticky: getComputedStyle(document.querySelector('#panel-summary tbody tr[data-row] > :first-child')).position,
        firstMonthLeft: document.querySelector('#panel-summary thead th:nth-child(2)').getBoundingClientRect().left,
        secondMonthRight: document.querySelector('#panel-summary thead th:nth-child(3)').getBoundingClientRect().right,
      };
    });
    assert.ok(m.sw <= 375, `scrollWidth ${m.sw}`);
    assert.ok(m.firstMonthLeft < 375 && m.secondMonthRight <= 375, `month columns not visible: ${m.firstMonthLeft}, ${m.secondMonthRight}`);
    assert.equal(m.overflow, 'auto');
    assert.equal(m.wrapScrolls, true);
    assert.equal(m.sticky, 'sticky');
    await page.close();
  }
});

const CHART_STUB = `window.Chart = class Chart {
  constructor(canvas, config) {
    this.canvas = canvas; this.config = config; this.data = config.data; this.options = config.options;
    this.updates = 0; this.destroyed = false; (window.__charts ||= []).push(this);
  }
  update() { this.updates++; }
  destroy() { this.destroyed = true; }
};`;

test('summary chart: stacked Fixed/Variable bars and Active PODs line on a second axis; re-render does not duplicate', async () => {
  const page = await openPage({ cdn: { [CHART]: CHART_STUB }, claude: { db: true, user: { can: true, id: 'u1' } } });
  await page.waitForFunction(() => window.__charts?.length >= 1);
  const info = () => page.evaluate(() => {
    const live = window.__charts.filter((c) => !c.destroyed);
    const c = live[live.length - 1];
    return {
      live: live.length,
      canvases: document.querySelectorAll('#panel-summary canvas').length,
      inDom: document.body.contains(c.canvas),
      sets: c.data.datasets.map((d) => ({ type: d.type, label: d.label, axis: d.yAxisID, color: d.backgroundColor ?? d.borderColor, data: d.data })),
      stacked: [c.options.scales.x.stacked, c.options.scales.y.stacked],
      y2: c.options.scales.y2?.position,
    };
  });
  let c = await info();
  assert.equal(c.live, 1);
  assert.equal(c.canvases, 1);
  assert.deepEqual(c.sets.map((s) => [s.type, s.label]), [['bar', 'Fixed'], ['bar', 'Variable'], ['line', 'Active PODs']]);
  assert.deepEqual(c.sets.map((s) => s.color.toUpperCase()), ['#005870', '#F4C400', '#46C3B2']);
  assert.deepEqual(c.stacked, [true, true]);
  assert.equal(c.sets[0].axis, c.sets[1].axis);
  assert.notEqual(c.sets[2].axis, c.sets[0].axis);
  assert.equal(c.y2, 'right');
  assert.equal(c.sets[2].data[11], 2000);
  const decFixed = c.sets[0].data[11];
  // an edit re-renders the summary: one live chart, updated in place or replaced
  await page.waitForFunction(() => document.getElementById('badge-view-only').hidden);
  await page.evaluate(() => window.__app.actions.setMonthly('csLicences', 11, 13));
  await page.waitForFunction((v) => {
    const live = window.__charts.filter((x) => !x.destroyed);
    return live.length === 1 && live[0].data.datasets[0].data[11] !== v;
  }, decFixed);
  c = await info();
  assert.equal(c.live, 1);
  assert.equal(c.canvases, 1);
  assert.equal(c.inDom, true);
  // the tooltip footer reflects the edited data, matching the table's December TOTAL cell
  const footer = await page.evaluate(() => {
    const ch = window.__charts.find((x) => !x.destroyed);
    const items = ch.data.datasets.map((d, i) => ({ dataset: d, datasetIndex: i, dataIndex: 11, parsed: { y: d.data[11] } }));
    return ch.options.plugins.tooltip.callbacks.footer(items);
  });
  const decTotal = await page.$eval('#panel-summary tr[data-row="r47"]', (tr) => tr.cells[12].textContent.trim());
  assert.equal(footer, `Total: €${decTotal}`);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('connect wait is capped: a can() that never resolves ends in View only, not Connecting…', async () => {
  const page = await openPage({ claude: {
    db: true, user: { can: true, id: 'u1' },
    script: 'window.__OCP_CONNECT_TIMEOUT_MS = 300; T.user = Object.freeze({ ...T.user, can: () => new Promise(() => {}) });',
  } });
  await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Connecting…');
  await page.waitForFunction(() => !document.getElementById('badge-view-only').hidden, null, { timeout: 3000 });
  assert.equal(await page.isHidden('#save-status'), true);
  assert.equal(await page.isVisible('#panel-summary .tile'), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('summary at 1280 px: columns are Line | Jan…Dec | Total 2027 and Total 2027 is fully visible', async () => {
  const page = await openPage();
  await page.waitForSelector('#panel-summary table');
  const m = await page.evaluate(() => {
    const wrap = document.querySelector('#panel-summary .table-scroll');
    const heads = [...document.querySelectorAll('#panel-summary thead th')];
    const w = wrap.getBoundingClientRect();
    return {
      heads: heads.map((x) => x.textContent.trim()),
      totalRight: heads[heads.length - 1].getBoundingClientRect().right,
      visibleRight: w.left + wrap.clientLeft + wrap.clientWidth,
      scrolls: wrap.scrollWidth > wrap.clientWidth,
    };
  });
  assert.deepEqual(m.heads, ['Line', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Total 2027']);
  assert.ok(m.totalRight <= m.visibleRight + 0.5, `Total 2027 right ${m.totalRight} > ${m.visibleRight}`);
  assert.equal(m.scrolls, false);
  await page.close();
});

test('capabilities arriving after the connect cap still attach: editor ends editable', async () => {
  const page = await openPage({ claude: {
    db: true, user: { can: true, id: 'u1' }, delayMs: 700,
    script: 'window.__OCP_CONNECT_TIMEOUT_MS = 300;',
  } });
  // after the cap, before the capabilities: seed view, View only, no Connecting…
  await page.waitForFunction(() => !document.getElementById('badge-view-only').hidden, null, { timeout: 3000 });
  assert.equal(await page.isHidden('#save-status'), true);
  // then the late db/user attach
  await page.waitForFunction(() => document.getElementById('badge-view-only').hidden && window.__app.getState().readOnly === false, null, { timeout: 3000 });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('a use(user) that never resolves does not drop the db: db plan shown, View only', async () => {
  const page = await openPage({ claude: {
    db: { docs: { 'plan/inputs': { scalars: {}, monthly: { csLicences: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] } } } },
    script: 'window.__OCP_CONNECT_TIMEOUT_MS = 300; T.user = new Promise(() => {});',
  } });
  await page.waitForFunction(() => window.__app.getState().source === 'db', null, { timeout: 3000 });
  await page.waitForFunction(() => !document.getElementById('badge-view-only').hidden, null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__app.getState().readOnly), true);
  assert.equal(await page.isHidden('#save-status'), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

// --- Inputs tab (Task 7)
const inputsSeed = JSON.parse(readFileSync(`${root}data/inputs.json`, 'utf8'));
const personnelSeed = JSON.parse(readFileSync(`${root}data/personnel.json`, 'utf8'));
// a db that already holds the v5 plan (so writes are per-field updates and remote updates apply)
const seededDocs = () => ({
  'plan/inputs': { monthly: inputsSeed.monthly, scalars: Object.fromEntries(inputsSeed.scalars.map((s) => [s.key, s.value])) },
  'plan/meta': { departments: personnelSeed.departments },
  ...Object.fromEntries(personnelSeed.roles.map((r) => [`roles/${r.id}`, r])),
});
const field = (key) => `#panel-inputs input[data-key="${key}"]`;
const fieldValue = (page, key) => page.$eval(field(key), (e) => e.value);
async function openInputs(opts = {}) {
  const page = await openPage({ claude: { db: { docs: seededDocs() }, user: { can: true, id: 'u1' } }, ...opts });
  await page.getByRole('tab', { name: 'Inputs' }).click();
  await page.waitForSelector(field('aiCallShare'));
  if (opts.editable !== false) await page.waitForFunction(() => window.__app.getState().readOnly === false && window.__app.getState().source === 'db');
  return page;
}

test('inputs: every scalar has a field in seed order, grouped by section, with label, unit and note', async () => {
  const page = await openInputs();
  const keys = await page.$$eval('#panel-inputs input[data-key]:not([data-key*=":"])', (els) => els.map((e) => e.dataset.key));
  assert.deepEqual(keys, inputsSeed.scalars.map((s) => s.key));
  const sections = await page.$$eval('#panel-inputs [data-section]', (els) => els.map((e) => e.dataset.section));
  assert.deepEqual(sections, [...new Set(inputsSeed.scalars.map((s) => s.section))]);
  const row = await page.$eval('#panel-inputs [data-row="csLicencePricePerMonth"]', (e) => e.textContent);
  assert.match(row, /EUR \/ licence \/ month/);
  assert.equal(await fieldValue(page, 'aiCallShare'), '60%');
  assert.equal(await fieldValue(page, 'haulogyFixedFeePerMonth'), '8,334');
  assert.equal(await fieldValue(page, 'recordingsPricePerMinute'), '0.0031');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('inputs: typing 50 into aiCallShare and blurring shows 50%, changes the Summary total, writes 0.5 within 1 s', async () => {
  const page = await openInputs();
  const total = () => page.$eval('#panel-summary .tile .tile-value', (e) => e.textContent.trim());
  assert.equal(await total(), '€1,216,931');
  await page.fill(field('aiCallShare'), '50');
  const t0 = Date.now();
  await page.locator(field('aiCallShare')).blur();
  assert.equal(await fieldValue(page, 'aiCallShare'), '50%');
  assert.notEqual(await total(), '€1,216,931');
  await page.waitForFunction(() => window.__test.db.writes.some((w) => w.path === 'plan/inputs' && w.data?.scalars?.aiCallShare === 0.5), null, { timeout: 1000 });
  assert.ok(Date.now() - t0 < 1000);
  const w = await page.evaluate(() => window.__test.db.writes.find((x) => x.path === 'plan/inputs'));
  assert.deepEqual(Object.keys(w.data.scalars), ['aiCallShare']); // one field per update
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('inputs: typing 90 into aiCallShare shows the AI + human error inline (live, before blur)', async () => {
  const page = await openInputs();
  await page.click(field('aiCallShare'));
  await page.fill(field('aiCallShare'), '90');
  const text = await page.textContent('#panel-inputs');
  assert.match(text, /AI \+ human share above 100%/);
  assert.equal(await page.$eval(field('aiCallShare'), (e) => e.getAttribute('aria-invalid')), 'true');
  assert.equal(await page.$eval('#panel-inputs [data-derived="noHumanNoAiShare"]', (e) => e.textContent.trim()), '-10%');
  await page.close();
});

test('inputs: Section A shows New customers total 2,000 and Difference vs target: 0; a change updates it live', async () => {
  const page = await openInputs();
  assert.equal(await page.$eval('#panel-inputs [data-check="newCustomersTotal"]', (e) => e.textContent.trim()), '2,000');
  assert.match(await page.textContent('#panel-inputs [data-check="newCustomersVsTarget"]'), /Difference vs target: 0/);
  assert.equal(await page.$$eval('#panel-inputs input[data-key^="newCustomers:"]', (e) => e.length), 12);
  assert.equal(await page.$$eval('#panel-inputs input[data-key^="csLicences:"]', (e) => e.length), 12);
  await page.fill(field('newCustomers:6'), '343');
  assert.equal(await page.$eval('#panel-inputs [data-check="newCustomersTotal"]', (e) => e.textContent.trim()), '2,010');
  const check = page.locator('#panel-inputs [data-check="newCustomersVsTarget"]');
  assert.match(await check.textContent(), /Difference vs target: 10/);
  assert.match(await check.getAttribute('class'), /is-warning/);
  await page.locator(field('newCustomers:6')).blur();
  await page.waitForFunction(() => window.__test.db.writes.some((w) => w.path === 'plan/inputs' && w.data?.monthly?.newCustomers?.[6] === 343));
  await page.close();
});

test('inputs: derived values are read-only (card share 23%, SEPA fee €0.35, card fee €1.95, no-human 20%)', async () => {
  const page = await openInputs();
  const d = await page.$$eval('#panel-inputs [data-derived]', (els) => Object.fromEntries(els.map((e) => [e.dataset.derived, { text: e.textContent.trim(), tag: e.tagName }])));
  assert.equal(d.paymentMixCard.text, '23%');
  assert.equal(d.sepaFeePerTx.text, '€0.35');
  assert.equal(d.cardFeePerTx.text, '€1.95');
  assert.equal(d.noHumanNoAiShare.text, '20%');
  for (const v of Object.values(d)) assert.notEqual(v.tag, 'INPUT');
  await page.close();
});

test('inputs: European entry, unparseable text is not written, empty is written as null and marked not filled', async () => {
  const page = await openInputs();
  await page.fill(field('costPerAiCall'), '1.234,5');
  await page.locator(field('costPerAiCall')).blur();
  assert.equal(await fieldValue(page, 'costPerAiCall'), '1,234.5');
  await page.fill(field('costOfContact'), '1,2x');
  await page.locator(field('costOfContact')).blur();
  assert.equal(await fieldValue(page, 'costOfContact'), '1,2x');
  assert.match(await page.textContent('#panel-inputs [data-row="costOfContact"]'), /Not a number/);
  await page.fill(field('podsPerCustomer'), '');
  await page.locator(field('podsPerCustomer')).blur();
  assert.match(await page.getAttribute(field('podsPerCustomer'), 'class'), /is-empty/);
  await page.waitForTimeout(900);
  const scalars = await page.evaluate(() => window.__test.db.writes.filter((w) => w.path === 'plan/inputs').map((w) => w.data.scalars));
  assert.ok(scalars.some((s) => s?.costPerAiCall === 1234.5));
  assert.ok(scalars.some((s) => s && 'podsPerCustomer' in s && s.podsPerCustomer === null));
  assert.ok(!scalars.some((s) => s && 'costOfContact' in s));
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('inputs: a remote save while typing keeps the focused text and updates the other field (Review Focus #2)', async () => {
  const page = await openInputs();
  await page.click(field('costOfContact'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('1,2');
  await page.evaluate(() => window.__test.db.remote('update', 'plan/inputs', { scalars: { costOfContact: 5, costPerAiCall: 2.5 } }));
  await page.waitForFunction(() => window.__app.getState().inputs.scalars.find((s) => s.key === 'costPerAiCall').value === 2.5);
  await page.waitForFunction((sel) => document.querySelector(sel).value === '2.5', field('costPerAiCall'));
  assert.equal(await fieldValue(page, 'costOfContact'), '1,2');
  assert.equal(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), field('costOfContact')), true);
  // committing afterwards: last save wins
  await page.locator(field('costOfContact')).blur();
  await page.waitForFunction(() => window.__test.db.docs.get('plan/inputs').scalars.costOfContact === 1.2, null, { timeout: 1500 });
  assert.equal(await fieldValue(page, 'costOfContact'), '1.2');
  await page.close();
});

test('inputs: viewer (can false) sees every input disabled with values visible', async () => {
  const page = await openInputs({ claude: { db: { docs: seededDocs() }, user: { can: false } }, editable: false });
  await page.waitForFunction(() => window.__app.getState().source === 'db');
  await page.waitForTimeout(100);
  const st = await page.$$eval('#panel-inputs input', (els) => ({ n: els.length, enabled: els.filter((e) => !e.disabled).length }));
  assert.ok(st.n >= 24 + 40);
  assert.equal(st.enabled, 0);
  assert.equal(await fieldValue(page, 'aiCallShare'), '60%');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('inputs at 375 px, light and dark: no page-level horizontal scroll, monthly table scrolls in its wrapper', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await openInputs({ colorScheme, viewport: { width: 375, height: 800 } });
    const m = await page.evaluate(() => {
      const wrap = document.querySelector('#panel-inputs .table-scroll');
      return { sw: document.documentElement.scrollWidth, wrapScrolls: wrap.scrollWidth > wrap.clientWidth, overflow: getComputedStyle(wrap).overflowX };
    });
    assert.ok(m.sw <= 375, `scrollWidth ${m.sw}`);
    assert.equal(m.overflow, 'auto');
    assert.equal(m.wrapScrolls, true);
    await page.close();
  }
});

test('inputs: ambiguous thousands-or-decimal entries are not written; 0,014 is', async () => {
  const page = await openInputs();
  // as a user does it (click, select all, type): Playwright's fill() selects before focusing, which the
  // raw-on-focus swap of "2,000" -> "2000" cannot see
  await page.click(field('yearEndCustomerTarget'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('2,000');
  await page.locator(field('yearEndCustomerTarget')).blur();
  const msg = await page.textContent('#panel-inputs [data-row="yearEndCustomerTarget"] .field-msg');
  assert.match(msg, /Ambiguous: 2000 or 2\?/);
  assert.match(msg, /not saved/);
  assert.equal(await fieldValue(page, 'yearEndCustomerTarget'), '2,000');
  await page.fill(field('newCustomers:6'), '8.334');
  await page.locator(field('newCustomers:6')).blur();
  assert.match(await page.textContent('#panel-inputs [data-series-msg]'), /Ambiguous: 8334 or 8\.334\?.*not saved/);
  assert.match(await page.getAttribute(field('newCustomers:6'), 'class'), /is-error/);
  // the stored value is first changed remotely, so typing 0,014 is a real edit
  await page.evaluate(() => window.__test.db.remote('update', 'plan/inputs', { scalars: { inboundCallPricePerMinute: 0.02 } }));
  await page.waitForFunction((sel) => document.querySelector(sel).value === '0.02', field('inboundCallPricePerMinute'));
  await page.fill(field('inboundCallPricePerMinute'), '0,014');
  await page.locator(field('inboundCallPricePerMinute')).blur();
  await page.waitForTimeout(900);
  const ws = await page.evaluate(() => window.__test.db.writes.filter((w) => w.path === 'plan/inputs').map((w) => w.data));
  assert.ok(ws.some((d) => d.scalars?.inboundCallPricePerMinute === 0.014));
  assert.ok(!ws.some((d) => d.scalars && 'yearEndCustomerTarget' in d.scalars));
  assert.ok(!ws.some((d) => d.monthly));
  assert.equal(await page.$eval('#panel-inputs [data-row="inboundCallPricePerMinute"] .field-msg', (e) => e.hidden), true);
  assert.equal(await fieldValue(page, 'inboundCallPricePerMinute'), '0.014');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('inputs: a blocked negative value is marked not saved; clearing the field then writes null', async () => {
  const page = await openInputs();
  await page.fill(field('costPerAiCall'), '-3');
  await page.locator(field('costPerAiCall')).blur();
  const msg = () => page.textContent('#panel-inputs [data-row="costPerAiCall"] .field-msg');
  assert.match(await msg(), /below 0.*not saved/);
  await page.fill(field('costPerAiCall'), '');
  await page.locator(field('costPerAiCall')).blur();
  await page.waitForFunction(() => window.__test.db.writes.some((w) => w.path === 'plan/inputs' && w.data.scalars && 'costPerAiCall' in w.data.scalars), null, { timeout: 1500 });
  const ws = await page.evaluate(() => window.__test.db.writes.filter((w) => w.path === 'plan/inputs' && w.data.scalars && 'costPerAiCall' in w.data.scalars).map((w) => w.data.scalars.costPerAiCall));
  assert.deepEqual(ws, [null]);
  assert.doesNotMatch(await msg(), /not saved/);
  await page.close();
});

test('inputs: tabbing into a grouped field and typing replaces the value (raw-on-focus keeps the selection)', async () => {
  const page = await openInputs();
  await page.focus(field('csLicences:11'));
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'yearEndCustomerTarget');
  await page.keyboard.type('2500');
  assert.equal(await fieldValue(page, 'yearEndCustomerTarget'), '2500');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__test.db.writes.some((w) => w.data?.scalars?.yearEndCustomerTarget === 2500), null, { timeout: 1500 });
  await page.close();
});

// --- Personnel tab (Task 8)
const pf = (key) => `#panel-personnel [data-key="${key}"]`;
const pfValue = (page, key) => page.$eval(pf(key), (e) => e.value);
const roleWrites = (page) => page.evaluate(() => window.__test.db.writes.filter((w) => w.path.startsWith('roles/')));
const summaryTotal = (page, row) => page.$eval(`#panel-summary tr[data-row="${row}"]`, (tr) => tr.cells[13].textContent.trim());
const typeInto = async (page, sel, text) => { await page.click(sel); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text); };
async function openPersonnel(opts = {}) {
  const page = await openPage({ claude: { db: { docs: seededDocs() }, user: { can: true, id: 'u1' } }, ...opts });
  await page.getByRole('tab', { name: 'Personnel' }).click();
  await page.waitForSelector('#panel-personnel tr[data-role="R13"]');
  if (opts.editable !== false) await page.waitForFunction(() => window.__app.getState().readOnly === false && window.__app.getState().source === 'db');
  return page;
}

test('personnel: 13 role rows with fields, R13 total 84,700, department totals Operations & Service 519,700', async () => {
  const page = await openPersonnel();
  assert.equal(await page.$$eval('#panel-personnel tr[data-role]', (e) => e.length), 13);
  assert.equal(await page.$eval('#panel-personnel tr[data-role="R13"] [data-total="cost"]', (e) => e.textContent.trim()), '84,700');
  assert.equal(await pfValue(page, 'R03:quarterlyCostAt1Fte'), '16,750');
  assert.equal(await pfValue(page, 'R03:oneOffHiringFee'), '10,000');
  assert.equal(await pfValue(page, 'R03:fte'), '1');
  assert.equal(await pfValue(page, 'R03:start'), '2027-04-01');
  assert.equal(await pfValue(page, 'R03:end'), '');
  assert.equal(await pfValue(page, 'R03:department'), 'Customer Service');
  assert.deepEqual(await page.$$eval(`${pf('R03:department')} option`, (o) => o.map((x) => x.value)), personnelSeed.departments);
  assert.equal(await page.$eval('#panel-personnel tr[data-dept="Operations & Service"][data-measure="cost"] .col-total', (e) => e.textContent.trim()), '519,700');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('personnel: department totals (cost) equal the Summary personnel lines, FTE total equals the Summary FTE row', async () => {
  const page = await openPersonnel();
  const cells = (sel) => page.$eval(sel, (tr) => [...tr.cells].slice(1).map((c) => c.textContent.trim()));
  for (const [i, dep] of ['Operations & Service', 'Billing & Invoicing', 'Customer Service', 'Pricing & Risk Management', 'Switching & Metering'].entries()) {
    assert.deepEqual(await cells(`#panel-personnel tr[data-dept="${dep}"][data-measure="cost"]`), await cells(`#panel-summary tr[data-row="r${40 + i}"]`), dep);
  }
  assert.deepEqual(await cells('#panel-personnel tr[data-dept="total"][data-measure="cost"]'), await cells('#panel-summary tr[data-row="r45"]'));
  assert.deepEqual(await cells('#panel-personnel tr[data-dept="total"][data-measure="fte"]'), await cells('#panel-summary tr[data-row="r66"]'));
  // per-role monthly values: R03 starts in April, so Jan-Mar are 0 and April books the hiring fee
  const r03 = await page.$eval('#panel-personnel tr[data-role-monthly="R03"][data-measure="cost"]', (tr) => [...tr.cells].slice(1).map((c) => c.textContent.trim()));
  assert.deepEqual(r03.slice(0, 4), ['0', '0', '0', '15,583']);
  await page.close();
});

test('personnel: Add role (Customer Service, 2027-07-01, FTE 1, 9,000 a quarter) raises the Summary line by 18,000 and writes roles/R14', async () => {
  const page = await openPersonnel();
  const before = Number((await summaryTotal(page, 'r42')).replace(/,/g, ''));
  await page.getByRole('button', { name: 'Add role' }).click();
  await page.waitForSelector(pf('R14:role'));
  assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'R14:role');
  await page.keyboard.type('Customer Service Agent');
  await page.keyboard.press('Enter');
  await page.selectOption(pf('R14:department'), 'Customer Service');
  await page.fill(pf('R14:start'), '2027-07-01');
  await page.locator(pf('R14:start')).blur();
  assert.equal(await pfValue(page, 'R14:fte'), '1');
  await typeInto(page, pf('R14:quarterlyCostAt1Fte'), '9000');
  await page.keyboard.press('Enter');
  await page.waitForFunction((b) => Number(document.querySelector('#panel-summary tr[data-row="r42"]').cells[13].textContent.replace(/,/g, '')) === b + 18000, before, { timeout: 2000 });
  await page.waitForFunction(() => {
    const d = window.__test.db.docs.get('roles/R14');
    return d && d.department === 'Customer Service' && d.start === '2027-07-01' && d.fte === 1 && d.quarterlyCostAt1Fte === 9000 && d.end === null && d.role === 'Customer Service Agent';
  }, null, { timeout: 2000 });
  assert.equal(await page.$$eval('#panel-personnel tr[data-role]', (e) => e.length), 14);
  assert.equal(await page.$eval('#panel-personnel tr[data-role="R14"] [data-total="cost"]', (e) => e.textContent.trim()), '18,000');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('personnel: delete asks for confirmation first, then removes the row and writes the delete', async () => {
  const page = await openPersonnel();
  const btn = '#panel-personnel [data-delete="R13"]';
  await page.click(btn);
  assert.equal((await page.textContent(btn)).trim(), 'Confirm delete');
  await page.waitForTimeout(200);
  assert.equal((await roleWrites(page)).length, 0);
  assert.equal(await page.$$eval('#panel-personnel tr[data-role]', (e) => e.length), 13);
  await page.click(btn);
  await page.waitForFunction(() => !document.querySelector('#panel-personnel tr[data-role="R13"]'));
  await page.waitForFunction(() => window.__test.db.writes.some((w) => w.op === 'delete' && w.path === 'roles/R13'), null, { timeout: 1500 });
  assert.equal(await page.$$eval('#panel-personnel tr[data-role]', (e) => e.length), 12);
  // Operations & Service drops by R13's 84,700
  assert.equal(await page.$eval('#panel-personnel tr[data-dept="Operations & Service"][data-measure="cost"] .col-total', (e) => e.textContent.trim()), '435,000');
  assert.equal(await summaryTotal(page, 'r40'), '435,000');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('personnel: an unconfirmed delete reverts after a few seconds', async () => {
  const page = await openPersonnel();
  const btn = '#panel-personnel [data-delete="R12"]';
  await page.click(btn);
  assert.equal((await page.textContent(btn)).trim(), 'Confirm delete');
  await page.waitForFunction((s) => document.querySelector(s).textContent.trim() === 'Delete', btn, { timeout: 6000 });
  assert.equal((await roleWrites(page)).length, 0);
  await page.close();
});

test('personnel: end date before start date warns (fee still booked, decision 1); blank start warns not counted', async () => {
  const page = await openPersonnel();
  // R03: start 2027-04-01, fee 10,000
  await page.fill(pf('R03:end'), '2027-03-01');
  await page.locator(pf('R03:end')).blur();
  await page.waitForFunction(() => window.__test.db.docs.get('roles/R03').end === '2027-03-01', null, { timeout: 1500 });
  const msg = () => page.textContent('#panel-personnel tr[data-role-msg="R03"]');
  assert.match(await msg(), /End date before start date/);
  assert.match(await msg(), /hiring fee/i);
  assert.equal(await page.$eval('#panel-personnel tr[data-role="R03"] [data-total="cost"]', (e) => e.textContent.trim()), '10,000');
  await page.fill(pf('R05:start'), '');
  await page.locator(pf('R05:start')).blur();
  await page.waitForFunction(() => window.__test.db.docs.get('roles/R05').start === null, null, { timeout: 1500 });
  assert.match(await page.textContent('#panel-personnel tr[data-role-msg="R05"]'), /No start date — not counted/);
  assert.equal(await page.$eval('#panel-personnel tr[data-role="R05"] [data-total="cost"]', (e) => e.textContent.trim()), '0');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('personnel: numeric fields refuse ambiguous and negative entries (not saved), accept 0,5 and 16750', async () => {
  const page = await openPersonnel();
  await typeInto(page, pf('R10:quarterlyCostAt1Fte'), '16,750');
  await page.locator(pf('R10:quarterlyCostAt1Fte')).blur();
  const msg = () => page.textContent('#panel-personnel tr[data-role-msg="R10"]');
  assert.match(await msg(), /Ambiguous: 16750 or 16\.75\?.*not saved/);
  assert.equal(await pfValue(page, 'R10:quarterlyCostAt1Fte'), '16,750');
  assert.match(await page.getAttribute(pf('R10:quarterlyCostAt1Fte'), 'class'), /is-error/);
  await typeInto(page, pf('R10:fte'), '-1');
  await page.locator(pf('R10:fte')).blur();
  assert.match(await msg(), /below 0.*not saved/);
  await page.waitForTimeout(300);
  assert.equal((await roleWrites(page)).length, 0);
  // fixing both writes them
  await typeInto(page, pf('R10:quarterlyCostAt1Fte'), '18000');
  await page.keyboard.press('Enter');
  await typeInto(page, pf('R10:fte'), '0,5');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => { const d = window.__test.db.docs.get('roles/R10'); return d.fte === 0.5 && d.quarterlyCostAt1Fte === 18000; }, null, { timeout: 1500 });
  assert.equal(await page.$eval('#panel-personnel tr[data-role-msg="R10"]', (e) => e.hidden), true);
  assert.equal(await pfValue(page, 'R10:quarterlyCostAt1Fte'), '18,000');
  // Escape drops a draft
  await typeInto(page, pf('R10:oneOffHiringFee'), '123');
  await page.keyboard.press('Escape');
  assert.equal(await pfValue(page, 'R10:oneOffHiringFee'), '0');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('personnel: a remote save while typing keeps the focused text and updates the rest', async () => {
  const page = await openPersonnel();
  await typeInto(page, pf('R02:role'), 'Deputy COO');
  await page.evaluate(() => {
    const r = window.__test.db.docs.get('roles/R02');
    return window.__test.db.remote('set', 'roles/R02', { ...r, role: 'Remote name', quarterlyCostAt1Fte: 60000 });
  });
  await page.waitForFunction((s) => document.querySelector(s).value === '60,000', pf('R02:quarterlyCostAt1Fte'));
  assert.equal(await pfValue(page, 'R02:role'), 'Deputy COO');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__test.db.docs.get('roles/R02').role === 'Deputy COO', null, { timeout: 1500 });
  assert.equal(await page.evaluate(() => window.__test.db.docs.get('roles/R02').quarterlyCostAt1Fte), 60000);
  await page.close();
});

test('personnel: viewer sees every control disabled and no add or delete buttons', async () => {
  const page = await openPersonnel({ claude: { db: { docs: seededDocs() }, user: { can: false } }, editable: false });
  await page.waitForFunction(() => window.__app.getState().source === 'db');
  await page.waitForTimeout(100);
  const st = await page.$$eval('#panel-personnel input, #panel-personnel select', (els) => ({ n: els.length, enabled: els.filter((e) => !e.disabled).length }));
  assert.equal(st.n, 13 * 8);
  assert.equal(st.enabled, 0);
  assert.equal(await page.$$eval('#panel-personnel [data-delete]', (els) => els.filter((e) => e.offsetParent !== null).length), 0);
  assert.equal(await page.getByRole('button', { name: 'Add role' }).isVisible(), false);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('personnel at 375 px, light and dark: no page-level horizontal scroll, the role table scrolls in its wrapper', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await openPersonnel({ colorScheme, viewport: { width: 375, height: 800 } });
    const m = await page.evaluate(() => {
      const wrap = document.querySelector('#panel-personnel .table-scroll');
      return { sw: document.documentElement.scrollWidth, wrapScrolls: wrap.scrollWidth > wrap.clientWidth, overflow: getComputedStyle(wrap).overflowX };
    });
    assert.ok(m.sw <= 375, `scrollWidth ${m.sw}`);
    assert.equal(m.overflow, 'auto');
    assert.equal(m.wrapScrolls, true);
    await page.close();
  }
});

test('personnel: two quick edits of the same role both survive (the second write builds on the first)', async () => {
  const page = await openPersonnel();
  await page.evaluate(() => {
    const edit = (key, value) => {
      const el = document.querySelector(`#panel-personnel [data-key="${key}"]`);
      el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur();
    };
    edit('R02:role', 'Deputy COO');
    edit('R02:fte', '0,5');
    const sel = document.querySelector('#panel-personnel [data-key="R02:department"]');
    sel.value = 'Customer Service'; sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__app.getState().status === 'saved', null, { timeout: 2000 });
  const d = await page.evaluate(() => window.__test.db.docs.get('roles/R02'));
  assert.equal(d.role, 'Deputy COO');
  assert.equal(d.fte, 0.5);
  assert.equal(d.department, 'Customer Service');
  assert.equal(await pfValue(page, 'R02:role'), 'Deputy COO');
  await page.close();
});

// --- Task 9: Read Me and Download Excel
const XLSX_STUB = `window.XLSX = (() => {
  const log = (window.__xl = { sheets: {}, order: [] });
  return {
    utils: {
      book_new: () => ({ names: [] }),
      aoa_to_sheet: (rows) => ({ rows }),
      book_append_sheet: (wb, ws, name) => { wb.names.push(name); log.sheets[name] = ws.rows; log.order.push(name); },
    },
    write: () => new Uint8Array([80, 75, 3, 4]),
  };
})();`;
const withXlsx = { [XLSX]: XLSX_STUB };
const DL_EDITOR = { db: true, user: { can: true, id: 'u1' }, downloads: true };
const status = (page) => page.$eval('#save-status', (e) => e.textContent);
const waitStatus = (page, text) => page.waitForFunction((t) => document.getElementById('save-status').textContent.includes(t), text, { timeout: 2000 });

test('Read Me: headings and definitions', async () => {
  const page = await openPage();
  await page.click('#tab-readme');
  const text = await page.$eval('#panel-readme', (e) => e.textContent);
  const heads = await page.$$eval('#panel-readme h2', (els) => els.map((e) => e.textContent.trim()));
  for (const h2 of ['How to use', 'Definitions', 'Calculation logic']) assert.ok(heads.includes(h2), `heading ${h2}`);
  for (const term of ['CTS average', 'CTS marginal', 'Fixed/Variable', 'Buckets', 'Outside CTS', 'PODs', 'FTE']) assert.ok(text.includes(term), `term ${term}`);
  assert.ok(text.includes('End date before start date') || /end date is before the start date/i.test(text), 'Decision 1 is explained');
  assert.ok(/December/.test(text));
  assert.ok(/active PODs show the 12-month average/.test(text), 'PODs Total column is the average');
  assert.equal(await page.$('#panel-readme .placeholder'), null);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('Download Excel: builds the sheets from the current state and saves through downloads', async () => {
  const page = await openPage({ claude: DL_EDITOR, cdn: withXlsx });
  await page.waitForSelector('#download-excel', { state: 'visible' });
  await page.waitForFunction(() => document.getElementById('badge-view-only')?.hidden === true);
  // an edit is part of the export
  await page.evaluate(() => window.__app.actions.setScalar('yearEndCustomerTarget', 2500));
  await page.click('#download-excel');
  await waitStatus(page, 'Excel downloaded');
  const r = await page.evaluate(() => ({ saves: window.__test.saves.map((s) => ({ filename: s.filename, n: s.data.length })), order: window.__xl.order, inputs: window.__xl.sheets.Inputs, summary: window.__xl.sheets.Summary, personnel: window.__xl.sheets.Personnel.length }));
  assert.equal(r.saves.length, 1);
  assert.equal(r.saves[0].filename, 'Operations_Cost_Plan_2027.xlsx');
  assert.ok(r.saves[0].n > 0);
  assert.deepEqual(r.order, ['Summary', 'Inputs', 'Personnel']);
  assert.ok(r.inputs.some((row) => row[1] && /target/i.test(row[1]) && row[2] === 2500), 'edited scalar exported');
  const total = r.summary.find((row) => /^TOTAL/i.test(String(row[0])));
  assert.ok(Math.abs(total[total.length - 1] - 1216931.37) < 0.01);
  assert.ok(r.personnel > 1);
  assert.equal(await page.isEnabled('#download-excel'), true);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('Download Excel: viewers can download too', async () => {
  const page = await openPage({ claude: { db: true, user: { can: false }, downloads: true }, cdn: withXlsx });
  await page.waitForSelector('#download-excel', { state: 'visible' });
  await page.click('#download-excel');
  await page.waitForFunction(() => window.__test.saves.length === 1);
  assert.equal(await page.isVisible('#badge-view-only'), true);
  await page.close();
});

test('Download Excel: button is disabled while saving and restored afterwards', async () => {
  const slow = 'T.downloads = Object.freeze({ save: (req) => new Promise((r) => setTimeout(() => { T.saves.push(req); r({ status: "delivered" }); }, 300)) });';
  const page = await openPage({ claude: { ...DL_EDITOR, script: slow }, cdn: withXlsx });
  await page.waitForSelector('#download-excel', { state: 'visible' });
  await page.click('#download-excel');
  assert.equal(await page.isDisabled('#download-excel'), true);
  await waitStatus(page, 'Excel downloaded');
  assert.equal(await page.isEnabled('#download-excel'), true);
  await page.close();
});

test('Download Excel: declined is quiet; unavailable, errors and a missing library are reported', async () => {
  const cases = [
    ['declined', 'T.downloads = Object.freeze({ save: async () => { throw Object.assign(new Error("no"), { code: "declined" }); } });', withXlsx, ''],
    ['unavailable', 'T.downloads = Object.freeze({ save: async () => { throw Object.assign(new Error("no"), { code: "not_granted" }); } });', withXlsx, 'Download not available'],
    ['failed', 'T.downloads = Object.freeze({ save: async () => { throw new Error("boom"); } });', withXlsx, 'Download failed'],
    ['no library', '', 'fail', "Excel library didn't load"],
  ];
  for (const [name, script, cdn, expected] of cases) {
    const page = await openPage({ claude: { ...DL_EDITOR, script }, cdn });
    await page.waitForSelector('#download-excel', { state: 'visible' });
    await page.click('#download-excel');
    if (expected) await waitStatus(page, expected);
    else { await page.waitForTimeout(150); assert.ok(!/downloaded|failed|not available/i.test(await status(page)), name); }
    assert.equal(await page.isEnabled('#download-excel'), true, name);
    if (name === 'no library') assert.equal(await page.evaluate(() => window.__test.saves.length), 0);
    await page.close();
  }
});

test('Download Excel: the button stays hidden when downloads is null', async () => {
  const page = await openPage({ claude: { db: true, user: { can: true, id: 'u1' }, downloads: null }, cdn: withXlsx });
  await page.waitForTimeout(150);
  assert.equal(await page.isHidden('#download-excel'), true);
  await page.close();
});
