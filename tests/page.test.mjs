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
