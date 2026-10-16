import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculate, summaryRows, SUMMARY_DEPARTMENTS } from '../src/calc.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const inputs = load('../data/inputs.json');
const { roles } = load('../data/personnel.json');
const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) <= 0.01, `${msg}: got ${actual}, expected ${expected}`);
const r2 = (x) => Math.round(x * 100) / 100;

// Check values published in README.md (v5 Excel).
test('v5 key check values', () => {
  const res = calculate(inputs, roles);
  near(res.aggregates.total.total, 1216931.37, 'Total 2027');
  near(r2(res.unitEconomics.ctsAverage.monthly[11]), 641.32, 'Dec CTS average per POD');
  near(r2(res.unitEconomics.ctsMarginal.monthly[11]), 124.46, 'Dec CTS marginal per POD');
  near(r2(res.unitEconomics.ctsAverage.total), 1854.40, 'Full-year CTS average per POD');
  near(r2(res.unitEconomics.ctsMarginal.total), 127.16, 'Full-year CTS marginal per POD');
});

test('aggregate checks are zero', () => {
  const { aggregates: a } = calculate(inputs, roles);
  for (let m = 0; m < 12; m++) {
    near(a.total.monthly[m] - a.variable.monthly[m] - a.fixed.monthly[m], 0, `fixed/var m${m + 1}`);
    near(a.total.monthly[m] - a.cts.monthly[m] - a.outside.monthly[m], 0, `bucket m${m + 1}`);
  }
});

test('new-customer phasing matches year-end target', () => {
  assert.equal(calculate(inputs, roles).derived.newCustomersVsTarget, 0);
});

// Golden file: every Summary row and role, within golden.tolerance.
const golden = load('./expected_v5.json');
const departments = load('../data/personnel.json').departments;
const rowId = (k) => k.match(/^(r\d+) /)[1];
const rows = () => summaryRows(calculate(inputs, roles, departments));

test('summaryRows returns exactly the golden rows, in order', () => {
  assert.deepEqual(rows().map((r) => r.row), Object.keys(golden.summaryLines).map(rowId));
});

test('golden v5 Summary rows', () => {
  const byId = Object.fromEntries(rows().map((r) => [r.row, r]));
  const tol = golden.tolerance;
  for (const [key, g] of Object.entries(golden.summaryLines)) {
    const r = byId[rowId(key)];
    assert.ok(r, `${key}: row missing`);
    g.monthly.forEach((v, m) => assert.ok(Math.abs(r.monthly[m] - v) <= tol, `${key} m${m + 1}: got ${r.monthly[m]}, expected ${v}`));
    assert.ok(Math.abs(r.total - g.total2027) <= tol, `${key} total: got ${r.total}, expected ${g.total2027}`);
    if (g.bucket) assert.equal(r.bucket, g.bucket, `${key} bucket`);
    if (g.fixedVariable) assert.equal(r.fv, g.fixedVariable, `${key} fv`);
  }
});

test('golden v5 personnel by role', () => {
  const res = calculate(inputs, roles, departments);
  for (const [id, g] of Object.entries(golden.personnelByRole)) {
    const p = res.personnel.roles.find((x) => x.id === id);
    assert.ok(p, `${id}: role missing`);
    g.fte.forEach((v, m) => assert.ok(Math.abs(p.fte.monthly[m] - v) <= 0.0001, `${id} fte m${m + 1}: got ${p.fte.monthly[m]}, expected ${v}`));
    g.cost.forEach((v, m) => near(p.cost.monthly[m], v, `${id} cost m${m + 1}`));
    near(p.cost.total, g.total2027, `${id} total`);
  }
});

// Review Focus #3: a department without roles stays on the Summary at 0 and totals stay balanced.
test('department with no roles keeps its row at zero and totals balanced', () => {
  const res = calculate(inputs, roles.filter((x) => x.department !== 'Billing & Invoicing'), SUMMARY_DEPARTMENTS);
  const byId = Object.fromEntries(summaryRows(res).map((r) => [r.row, r]));
  assert.ok(byId.r41, 'r41 exists');
  assert.deepEqual(byId.r41.monthly, Array(12).fill(0));
  for (let m = 0; m < 12; m++) near(byId.r47.monthly[m] - (byId.r50.monthly[m] + byId.r51.monthly[m]), 0, `balance m${m + 1}`);
});

// Edge cases (SPEC §7.2)
const zeroInputs = () => {
  const z = structuredClone(inputs);
  z.monthly.newCustomers = Array(12).fill(0);
  z.monthly.csLicences = Array(12).fill(0);
  z.scalars.forEach((s) => { s.value = 0; });
  return z;
};

test('all-zero inputs give finite numbers and 0 CTS per POD', () => {
  const res = calculate(zeroInputs(), []);
  const walk = (o) => {
    if (typeof o === 'number') assert.ok(Number.isFinite(o), 'non-finite value');
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(res);
  assert.equal(res.unitEconomics.ctsAverage.total, 0);
  assert.equal(res.unitEconomics.ctsAverage.monthly[11], 0);
});

test('end date before start: no salary, hiring fee still booked (Excel)', () => {
  const role = { id: 'X', department: 'Customer Service', start: '2027-06-01', end: '2027-03-31', fte: 1, quarterlyCostAt1Fte: 30000, oneOffHiringFee: 500 };
  const p = calculate(inputs, [role]).personnel.roles[0];
  assert.equal(p.cost.total, 500);
  assert.equal(p.cost.monthly[5], 500); // June, the start month
});

test('hiring fee booked only when start falls in 2027', () => {
  const base = { department: 'Customer Service', end: null, fte: 1, quarterlyCostAt1Fte: 3000, oneOffHiringFee: 500 };
  const res = calculate(inputs, [
    { ...base, id: 'A', start: '2026-10-01' },
    { ...base, id: 'B', start: '2027-03-15' },
  ]);
  const [a, b] = res.personnel.roles;
  near(a.cost.total, 12000, 'pre-2027 role: no fee');
  assert.equal(a.cost.monthly[0], 1000);
  // March: 17/31 days of 1000 + 500 fee
  near(b.cost.monthly[2], 1000 * 17 / 31 + 500, 'March cost with fee');
});

test('partial-month FTE uses calendar days, inclusive', () => {
  const role = { id: 'P', department: 'Customer Service', start: '2027-02-15', end: '2027-02-20', fte: 0.5, quarterlyCostAt1Fte: 0, oneOffHiringFee: 0 };
  near(calculate(inputs, [role]).personnel.roles[0].fte.monthly[1], 0.5 * 6 / 28, 'Feb FTE');
});

test('AI + human share above 100% is an error', () => {
  const bad = structuredClone(inputs);
  bad.scalars.find((s) => s.key === 'aiCallShare').value = 0.9;
  assert.ok(calculate(bad, roles).errors.some((e) => /noHumanNoAiShare/.test(e)));
});
