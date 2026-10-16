import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSheets, exportXlsx } from '../src/export.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const inputs = load('../data/inputs.json');
const { roles, departments } = load('../data/personnel.json');
const sheets = () => buildSheets(inputs, roles, departments);

test('Summary: header, 46 rows, total row', () => {
  const s = sheets().Summary;
  assert.deepEqual(s[0].slice(0, 4), ['Line', 'Bucket', 'Fixed/Variable', 'Jan 2027']);
  assert.equal(s[0].length, 16);
  assert.deepEqual(s[0].slice(-2), ['Dec 2027', 'Total 2027']);
  assert.equal(s.length - 1, 46);
  const total = s.find((r) => r[0] === 'TOTAL OPERATIONS COST');
  assert.ok(Math.abs(total[total.length - 1] - 1216931.37) <= 0.01);
});

test('Inputs: seed rows as fractions, plus monthly series', () => {
  const i = sheets().Inputs;
  const e = inputs.scalars.find((x) => x.key === 'paymentMixSepa');
  assert.deepEqual(i.find((r) => r[1] === e.label), [e.section, e.label, 0.77, e.unit, e.note]);
  const nc = i.find((r) => r[0] === 'New customers');
  assert.equal(nc.length, 13);
  assert.deepEqual(nc.slice(1), inputs.monthly.newCustomers);
});

test('Personnel: 13 roles with 12 monthly cost columns', () => {
  const p = sheets().Personnel;
  assert.equal(p.length - 1, 13);
  assert.equal(p[0].length, 9 + 12 + 1);
  assert.equal(p[0][21], 'Total 2027');
  assert.equal(p[1][0], 'R01');
});

test('buildSheets does not mutate engine data', () => {
  const a = JSON.stringify(sheets());
  assert.equal(JSON.stringify(sheets()), a);
});

const fakeXlsx = () => {
  const calls = [];
  return {
    calls,
    utils: {
      aoa_to_sheet: (rows) => { calls.push(['sheet', rows.length]); return { rows }; },
      book_new: () => ({ sheets: [] }),
      book_append_sheet: (wb, ws, name) => { wb.sheets.push(name); calls.push(['append', name]); },
    },
    write: (wb, opts) => { calls.push(['write', opts]); return new Uint8Array([1, 2]); },
  };
};

test('exportXlsx saves and returns status', async () => {
  const XLSX = fakeXlsx();
  let saved;
  const downloads = { save: async (a) => { saved = a; return { status: 'saved' }; } };
  const res = await exportXlsx({ XLSX, downloads, sheets: sheets() });
  assert.equal(res, 'saved');
  assert.equal(saved.filename, 'Operations_Cost_Plan_2027.xlsx');
  assert.deepEqual(XLSX.calls.filter((c) => c[0] === 'append').map((c) => c[1]), ['Summary', 'Inputs', 'Personnel']);
  assert.deepEqual(XLSX.calls.find((c) => c[0] === 'write')[1], { type: 'array', bookType: 'xlsx' });
});

test('exportXlsx maps rejections', async () => {
  const rej = (code) => ({ save: async () => { throw { code, message: code }; } });
  const run = (downloads) => exportXlsx({ XLSX: fakeXlsx(), downloads, sheets: sheets() });
  assert.equal(await run(rej('declined')), 'declined');
  assert.equal(await run(null), 'unavailable');
  for (const c of ['not_granted', 'capability_disabled', 'capability_removed', 'unavailable']) assert.equal(await run(rej(c)), 'unavailable');
  await assert.rejects(run(rej('boom')), { code: 'boom' });
});
