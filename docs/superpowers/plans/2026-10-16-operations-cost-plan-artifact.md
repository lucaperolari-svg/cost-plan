# Operations Cost Plan 2027 Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single self-contained claude.ai Artifact page that reproduces the v5 Excel cost plan exactly, lets editors change inputs and roles live for everyone, and exports to Excel.

**Architecture:** A pure calculation engine (`src/calc.js`, already built) feeds a vanilla-JS UI with four tabs. A small store module wraps the artifact `db` capability, falling back to the bundled seed when `db` is absent, and a build script inlines everything into `dist/index.html`. Pure modules are unit-tested in Node; the built page is smoke-tested in Chromium with a fake `window.claude`.

**Tech Stack:** Node 22 (`node:test`), vanilla ES modules, esbuild (dev only, bundling), Playwright with preinstalled Chromium (dev only, page tests), Chart.js 4.4.1 and SheetJS 0.18.5 from cdnjs, Montserrat from Google Fonts.

**Spec:** `SPEC.md`, `CALCULATIONS.md`, `CLAUDE.md`; golden results `tests/expected_v5.json`; source model `reference/Operations_Cost_Plan_2027_v5.xlsx`.

## Decisions needed from Luca before Task 1 and Task 3

1. **Hiring fee when end date < start date.** The Excel books the fee in the start month regardless (`Personnel!V8 = $H8/3*J8 + IF(AND($E8<>"",$E8>=V$4,$E8<=V$5),$I8,0)`). SPEC §7.2 says such a role costs 0. **Recommendation:** match the Excel, because the engine's job is to reproduce it, and show a "End date before start date" warning on the row. Only the edge-case test in Task 1 changes with the answer.
2. **Concurrent edits (SPEC §5).** The `db` capability has no version pinning or `conflict` error; writes are last-writer-wins, and `update` merges nested objects. **Recommendation:** write one field per `update` (`{scalars: {key: v}}` merges just that key; a monthly array replaces only that array), and never overwrite the input that has focus with a remote change. Two editors editing different fields never clobber each other; editing the same field means the last save wins.

## Global Constraints

- Every Summary line, subtotal, aggregate, key figure and unit-economics row, plus every role's monthly FTE and cost, matches `tests/expected_v5.json` within €0.01 (FTE within 0.0001).
- `src/calc.js` is pure: no DOM, no `window`, no `claude` calls.
- Output is one file, `dist/index.html`. The only external scripts are `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js` and `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js`; the only stylesheet is Google Fonts Montserrat.
- Capabilities declared at publish: `{db: {rules: [{path: "", read: "view", write: "admin"}]}, user: {}, downloads: true}`.
- `claude.use(...)` may resolve `null`, and `window.claude` may be absent: the page must always render (read-only, from the bundled seed).
- `db` paths: `plan/inputs` `{monthly: {newCustomers[12], csLicences[12]}, scalars: {key: value}, updatedAt, updatedBy}`, `plan/meta` `{departments[5]}`, `roles/{id}` (fields as in `data/personnel.json`). `updatedBy` stores the `user.id()` value, never a name.
- Labels, units, sections and notes for scalars come from the bundled `data/inputs.json`. The db holds values only.
- Shares are stored as fractions and shown as %. A scalar is a share when its `unit` starts with `%`.
- MET colours: Petrol `#005870`, Yellow `#F4C400` (accents and backgrounds only, never small text), Cool Gray 10 `#63656A`; chart series Petrol, then Yellow, Teal `#46C3B2`, Green `#6BC04B`, Purple `#A45B96`, Light Blue `#88D2E7`. Logo: `MET_Logo_Blue_RGB_NEW.png` (light) and `MET_Logo_White_RGB_NEW.png` (dark) from the met-branding skill, inlined as data URIs.
- Light and dark mode; at 375 px width, 16 px side gutter, no page-level horizontal scroll, and tables scroll inside their own container.
- Out of scope: HR Dashboard link, scenarios, CTA, comments, edit history, approvals.

## Review Focus

1. **European number entry:** typing `1,5`, `1.234,56`, ` 15 % ` or `15%` into a field. Expected: `1.5`, `1234.56`, `0.15` for a share field. Pinned in Task 2 (`parseNumber`).
2. **Remote change while typing:** another editor's save arrives while you are typing in the same input. Expected: your input keeps your text and the rest of the page updates. Pinned in Task 7 (Playwright).
3. **Department with no roles:** all roles of a department are deleted. Expected: all five department rows stay on the Summary and show 0; totals stay balanced. Pinned in Task 1.
4. **Viewer cannot write, or db empty or missing:** expected: seed values shown, every input disabled, no write attempted, a "View only" badge. Pinned in Task 3.
5. **Two editors on different fields within the 600 ms window:** expected: both changes survive. Pinned in Task 3.

---

### Task 1: Golden test and engine alignment

**Files:**
- Modify: `tests/calc.test.js` (replace the skipped golden placeholder)
- Modify: `src/calc.js`

**Interfaces:**
- Consumes: `calculate(inputs, roles, departments?)` from `src/calc.js` (exists).
- Produces: `summaryRows(result) -> Array<{row: string, kind: 'line'|'subtotal'|'total'|'aggregate'|'keyFigure'|'unitEconomics', label: string, monthly: number[12], total: number, bucket?: string, fv?: string, format: 'eur'|'count'|'fte'|'eurPerPod'}>`, exported from `src/calc.js`. `row` is the Excel row number as in the golden keys (`'r06'` … `'r72'`), in Excel order. This is the single source for the Summary table and the Excel export.
- Produces: `SUMMARY_DEPARTMENTS = ['Operations & Service', 'Billing & Invoicing', 'Customer Service', 'Pricing & Risk Management', 'Switching & Metering']` (Excel rows r40–r44).

- [ ] **Step 1: Write the failing golden test.** Parse each golden key as `/^(r\d+) /` to get the row id and look it up in `summaryRows(calculate(inputs, roles, departments))`. For every row: assert all 12 `monthly` values and `total` within `golden.tolerance`; for line rows, also assert `bucket === golden.bucket` and `fv === golden.fixedVariable`. For each `personnelByRole` id: compare `fte[m]` within 0.0001, and `cost[m]` and `total2027` within 0.01. Add a test that `summaryRows` returns exactly the 46 golden row ids in the same order.
- [ ] **Step 2: Add the Review Focus #3 test.** With `roles` filtered to remove every `Billing & Invoicing` role, row `r41` exists with all zeros, and `r47` minus (`r50` + `r51`) is 0 in every month.
- [ ] **Step 3: Apply decision 1 to the edge-case test.** If the answer is "match Excel": change `end date before start gives zero role cost` to use a fee of 500 and assert a total of 500 booked in the start month. If the answer is "cost 0": keep the test as it is and also assert 0 with a fee of 500.
- [ ] **Step 4: Run `npm test`.** Expected: FAIL on `summaryRows is not a function`.
- [ ] **Step 5: Implement `summaryRows` in `src/calc.js`, and the engine fixes it needs:**
  - `keyFigures.pods.total` = average of 12 months (golden r64 = 582.916667). The current value is December's, the only mismatch found so far. CALCULATIONS §2's "Total = December" applies to the Calculations sheet, not the Summary row.
  - Department lines follow `SUMMARY_DEPARTMENTS` order; any other department found in roles is appended after them.
  - If decision 1 = "cost 0": no hiring fee when `end < start`.
  - Rows: lines r06–r09, r13–r15, r19–r24, r28–r29, r33–r36, r40–r44; subtotals r10, r16, r25, r30, r37, r45; r47 total; r50 variable, r51 fixed; r55 ctsOps, r56 ctsCare, r57 cts, r58 ctsVariable, r59 outside; r63 new customers, r64 PODs, r65 payments, r66 FTE; r69 ctsAverage, r70 ctsOps, r71 ctsCare, r72 ctsMarginal.
- [ ] **Step 6: Run `npm test`.** Expected: all pass, 0 skipped.
- [ ] **Step 7: Commit:** `git commit -m "Golden test vs expected_v5.json and Summary row model"`

### Task 2: Number parsing and input validation

**Files:**
- Create: `src/validate.js`, `tests/validate.test.js`

**Interfaces:**
- Produces: `parseNumber(text: string, {share: boolean}) -> number | null`. `null` for an empty or unparseable value. Accepts `,` as the decimal separator when there is no `.`, or when `,` comes after the last `.` (then `.` is a thousands separator). Strips spaces and a trailing `%`. When `share` is true, divides by 100.
- Produces: `isShare(scalar) -> boolean` (`unit` starts with `%`).
- Produces: `validateInputs(inputs) -> Array<{key: string, level: 'error'|'warning'|'empty', message: string}>`. `key` is a scalar key, `'newCustomers'` or `'csLicences'`.
- Produces: `formatShare(fraction) -> string` (`0.77` → `'77%'`, `0.017` → `'1.7%'`).

- [ ] **Step 1: Write the failing tests.**
  - `parseNumber('1,5') === 1.5`, `parseNumber('1.234,56') === 1234.56`, `parseNumber('1,234.56') === 1234.56`, `parseNumber(' 15 % ', {share: true}) === 0.15`, `parseNumber('15', {share: true}) === 0.15`, `parseNumber('') === null`, `parseNumber('abc') === null`.
  - `validateInputs` on the seed returns `[]`. Seed with `aiCallShare = 0.9` returns an `error` on `aiCallShare` containing "above 100%". `paymentMixSepa = 1.2` gives an `error` (share above 100%). `pricePerSms = -1` gives an `error` (below 0). Value `null` gives `empty`. `newCustomers[6] = 0` (total 1,667 vs target 2,000) gives a `warning` on `newCustomers` containing "-333".
- [ ] **Step 2: Run `node --test tests/validate.test.js`.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/validate.js`.** The engine already treats `null` as 0; validation only flags it.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit:** `git commit -m "Number parsing and input validation"`

### Task 3: Store (db wrapper) and seed batch

**Files:**
- Create: `src/store.js`, `tests/store.test.js`, `tests/fake-db.js`, `scripts/seed-batch.mjs`

**Interfaces:**
- Consumes: the db API per `artifact-capabilities` 0.2.82 `db.d.ts`: `db.doc(path).onSnapshot(next, err)`, `.update(obj)`, `.set(obj)`, `.delete()`, `db.collection('roles').onSnapshot(...)`; `user.can('data.write') -> true|false|null`, `user.id()`.
- Produces: `createStore({db, user, seed: {inputs, roles, departments}, debounceMs = 600}) -> Store`:
  - `getState() -> {inputs, roles, departments, readOnly: boolean, source: 'seed'|'db', status: 'idle'|'saving'|'saved'|'error', error?: string}`. `inputs` has the same shape as `data/inputs.json`, with db values merged onto the seed metadata.
  - `subscribe(fn: (state) => void) -> unsubscribe`
  - `setScalar(key, value)`, `setMonthly(name: 'newCustomers'|'csLicences', index, value)`, `upsertRole(role)`, `deleteRole(id)`
  - `dispose()`
- Produces: `fakeDb()` test double in `tests/fake-db.js`, implementing `doc`/`collection`/`onSnapshot`/`update`/`set`/`delete` with recursive merge on `update`, and a `writes` log.
- Produces: `node scripts/seed-batch.mjs > seed-batch.json`, which writes the `ArtifactData` batch ops (`set plan/inputs`, `set plan/meta`, `set roles/R01…R13`).

- [ ] **Step 1: Write the failing tests** (use `mock.timers` for the debounce):
  - With `db = null`: state is the seed, `readOnly: true`, `source: 'seed'`, and `setScalar` changes nothing.
  - With an empty fake db and `can → true`: state is the seed, `source: 'seed'`, `readOnly: false`. The first edit writes `plan/inputs` with `set` (the full seed values plus the change), since `update` requires the document to exist.
  - Review Focus #4: `can('data.write') → false` gives `readOnly: true` and zero writes after `setScalar`.
  - Review Focus #5: `setScalar('aiCallShare', 0.5)` and `setScalar('costOfContact', 1)` within 600 ms produce one `update` carrying `{scalars: {aiCallShare: 0.5, costOfContact: 1}}`. A second store instance on the same fake db that updated `pricePerSms` in between keeps its value.
  - A remote snapshot changes `state.inputs` and notifies subscribers.
  - `update` rejecting with `{code: 'invalid_argument'}` switches to `readOnly: true` with `status: 'error'`; `unavailable` retries once.
  - `upsertRole` calls `set` on `roles/{id}`; `deleteRole` calls `delete`.
- [ ] **Step 2: Run `node --test tests/store.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement `src/store.js`.** Keep a single pending patch per document; flush it after `debounceMs` of quiet, await each write before the next to the same document, and set `updatedAt` (ISO string) and `updatedBy` (`await user.id()`) on every write. `readOnly` is true when `db` is null or `can('data.write') === false`; `null` means keep inputs editable and let a refused write decide.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Write `scripts/seed-batch.mjs` and check it:** `node scripts/seed-batch.mjs | node -e "const b=JSON.parse(require('fs').readFileSync(0));console.log(b.length)"`. Expected: `15`.
- [ ] **Step 6: Commit:** `git commit -m "db store with debounce, read-only fallback and seed batch"`

### Task 4: Excel export model

**Files:**
- Create: `src/export.js`, `tests/export.test.js`

**Interfaces:**
- Consumes: `summaryRows` (Task 1), `calculate`.
- Produces: `buildSheets(inputs, roles, departments) -> {Summary: any[][], Inputs: any[][], Personnel: any[][]}` (arrays of rows, values only).
- Produces: `exportXlsx({XLSX, downloads, sheets, filename = 'Operations_Cost_Plan_2027.xlsx'}) -> Promise<'saved'|'delivered'|'declined'|'unavailable'>`.

- [ ] **Step 1: Write the failing tests.**
  - `Summary` header is `['Line', 'Bucket', 'Fixed/Variable', 'Jan 2027', …, 'Dec 2027', 'Total 2027']`; there are 46 data rows; the `TOTAL OPERATIONS COST` row's last cell is within 0.01 of 1216931.37.
  - `Inputs` contains the `paymentMixSepa` row `[section, label, 0.77, unit, note]` taken from the seed entry, with shares stored as fractions.
  - `Personnel` has 13 role rows with 12 monthly cost columns.
  - `exportXlsx` with a fake `downloads.save` rejecting `{code: 'declined'}` resolves `'declined'`; with `downloads = null` it resolves `'unavailable'`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** `exportXlsx` uses `XLSX.utils.aoa_to_sheet`, `book_new`, `book_append_sheet`, `XLSX.write(wb, {type: 'array', bookType: 'xlsx'})`, then `downloads.save({filename, data})`.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit:** `git commit -m "Excel export model"`

### Task 5: Build pipeline and page shell

**Files:**
- Create: `build.mjs`, `src/page.html`, `src/styles.css`, `src/ui/main.js`, `src/ui/dom.js`, `src/assets/met-logo-blue.png`, `src/assets/met-logo-white.png`, `tests/page.test.mjs`
- Modify: `package.json` (devDependencies `esbuild` and `playwright` at exact versions; scripts `build`, `test:page`)

**Interfaces:**
- Produces: `npm run build` writes `dist/index.html`, the bundled IIFE of `src/ui/main.js` inlined in `<script>` with CSS and logos inlined.
- Produces: `src/ui/dom.js`: `h(tag, attrs, ...children) -> Element` and `fmt.eur(n)`, `fmt.int(n)`, `fmt.pct(n)`, `fmt.fte(n)` (`en-IE` locale, EUR, 0 decimals in tables, 2 in tiles).
- Produces: the page shell, which renders tabs `Summary | Inputs | Personnel | Read Me`, a status area (`View only` badge, saving indicator) and a `Download Excel` button. `main.js` exposes `mountTab(name, renderFn)` for Tasks 6–9.
- Produces: `tests/page.test.mjs`, a Playwright harness: `openPage({claude?: fakeClaude}) -> page`, loading `dist/index.html` from `file://` with Chromium at `/opt/pw-browsers/chromium` (or the `PLAYWRIGHT_BROWSERS_PATH` default) and an optional `window.claude` stub injected with `addInitScript`.

- [ ] **Step 1: Write the failing page test.** With no `window.claude`: the page shows four tabs and the `View only` badge, there are no console errors, and `document.scripts` srcs are only the two cdnjs URLs.
- [ ] **Step 2: Run `npm run build && node --test tests/page.test.mjs`.** Expected: FAIL.
- [ ] **Step 3: Implement the build and shell.** Copy the two logos from the met-branding skill into `src/assets/`. Colour tokens go on `:root`, with dark values under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and again under `:root[data-theme="dark"]`, and `body` gets an explicit background. Load `artifact-design` before writing CSS.
- [ ] **Step 4: Run the page test and `npm test`.** Expected: all pass. Also check the size: `wc -c dist/index.html` is under 1 MB.
- [ ] **Step 5: Commit:** `git commit -m "Build pipeline and page shell"`

### Task 6: Summary tab

**Files:**
- Create: `src/ui/summary.js`
- Modify: `tests/page.test.mjs`

**Interfaces:**
- Consumes: `summaryRows`, `fmt`, the store state.
- Produces: `renderSummary(container, result)`.

- [ ] **Step 1: Write the failing page tests.**
  - Headline tiles show `€1,216,931`, `€641.32` (Dec CTS average), `€124.46` (Dec CTS marginal), and the fixed share `93.9%` (1,142,807 / 1,216,931.37).
  - The table has 46 body rows; the `TOTAL OPERATIONS COST` row's Total cell shows `1,216,931`.
  - Line rows show their bucket and F/V tags.
  - At a 375 px viewport, `document.documentElement.scrollWidth <= 375`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The table has a sticky first column inside an `overflow-x: auto` wrapper. The chart (Chart.js) shows stacked bars Fixed (Petrol) and Variable (Yellow), with Active PODs as a line (Teal) on a second axis; it is skipped when `window.Chart` is undefined.
- [ ] **Step 4: Run all tests.** Expected: pass.
- [ ] **Step 5: Commit:** `git commit -m "Summary tab"`

### Task 7: Inputs tab

**Files:**
- Create: `src/ui/inputs.js`
- Modify: `tests/page.test.mjs`

**Interfaces:**
- Consumes: `parseNumber`, `isShare`, `formatShare`, `validateInputs`, `deriveInputs`, and `store.setScalar` / `store.setMonthly`.
- Produces: `renderInputs(container, state, store)`. Each input carries `data-key`.

- [ ] **Step 1: Write the failing page tests** (with a fake `claude` whose `db` is `fakeDb` seeded and `user.can → true`):
  - Typing `50` into `aiCallShare` and blurring shows `50%` and changes the Summary total. A `0.5` write lands within 1 s.
  - Typing `90` into `aiCallShare` shows the "AI + human share above 100%" error inline.
  - Section A shows the New customers total `2,000` and "Difference vs target: 0".
  - Derived values (card share 23%, SEPA fee €0.35, card fee €1.95) are shown read-only.
  - Review Focus #2: focus `costOfContact` and type `1,2` without blurring, then push a remote snapshot setting `costOfContact` to 5. The input still shows `1,2`, and another field changed in the same snapshot updates.
  - With `can → false`, every input is `disabled`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Scalars are grouped by `section` in seed order; each row shows label, value, unit and note. Empty values get a "not filled" style. Recalculation runs on every input event; the store write happens on change.
- [ ] **Step 4: Run all tests.** Expected: pass.
- [ ] **Step 5: Commit:** `git commit -m "Inputs tab"`

### Task 8: Personnel tab

**Files:**
- Create: `src/ui/personnel.js`
- Modify: `tests/page.test.mjs`

**Interfaces:**
- Consumes: `roleMonthly`, `calculate(...).personnel`, `store.upsertRole` / `store.deleteRole`, the departments from state.
- Produces: `renderPersonnel(container, state, store)`.

- [ ] **Step 1: Write the failing page tests.**
  - There are 13 rows; R13's total shows `84,700`.
  - The department totals table shows Operations & Service `519,700`.
  - Add a role (department "Customer Service", start 2027-07-01, FTE 1, quarterly cost 9,000): the Summary Customer Service line rises by 18,000, and the `roles/{newId}` write lands.
  - Deleting a role removes it and writes the delete.
  - An end date before the start date shows the warning (decision 1).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** New ids are the next `R##`. Department is a `<select>` of the five departments; dates use `<input type="date">`, with blank end = open.
- [ ] **Step 4: Run all tests.** Expected: pass.
- [ ] **Step 5: Commit:** `git commit -m "Personnel tab"`

### Task 9: Read Me tab and Excel download

**Files:**
- Create: `src/ui/readme.js`
- Modify: `src/ui/main.js`, `tests/page.test.mjs`

**Interfaces:**
- Consumes: `buildSheets`, `exportXlsx`.
- Produces: `renderReadme(container)`, and the `Download Excel` click handler.

- [ ] **Step 1: Write the failing page tests.**
  - Read Me contains the headings "How to use", "Definitions" and "Calculation logic", plus the terms CTS average, CTS marginal, Fixed/Variable, Buckets and Outside CTS.
  - Clicking `Download Excel` with a fake `downloads.save` calls it once with `filename` ending in `.xlsx` and a non-empty `data`, when `window.XLSX` is stubbed. The button is hidden when `downloads` is null.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Read Me text is a summary of SPEC §6.4 and CALCULATIONS §1–10 in plain sentences.
- [ ] **Step 4: Run all tests.** Expected: pass.
- [ ] **Step 5: Commit:** `git commit -m "Read Me tab and Excel download"`

### Task 10: Publish, seed and verify

**Files:**
- Modify: `README.md` (how to build, test and republish; the artifact link)

- [ ] **Step 1: Run `npm test && npm run build && node --test tests/page.test.mjs`.** Expected: all pass.
- [ ] **Step 2: Publish** `dist/index.html` with the Artifact tool, using `icon: "chart"` and the capabilities from Global Constraints.
- [ ] **Step 3: Seed** with `ArtifactData` `batch`, using the ops from `node scripts/seed-batch.mjs`.
- [ ] **Step 4: Verify.** `ArtifactData list` on `roles` returns 13 documents, and `get plan/inputs` returns 43 scalars. The same reads with `as_level: "view"` succeed, and a `view`-level write is refused. Reopen the page: the total is €1,216,931.37, and December CTS is €641.32 average and €124.46 marginal.
- [ ] **Step 5: Commit the README update and push.**
