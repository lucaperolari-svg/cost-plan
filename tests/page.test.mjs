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
