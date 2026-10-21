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

// a SheetJS-like aoa_to_sheet: one cell object per non-empty value, keyed by A1 address
const col = (c) => { let s = ''; for (c++; c; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };
const cellXlsx = () => {
  const books = {};
  return {
    books,
    utils: {
      aoa_to_sheet: (rows) => {
        const ws = {};
        rows.forEach((row, r) => row.forEach((v, c) => { if (v !== undefined && v !== null) ws[`${col(c)}${r + 1}`] = { v, t: typeof v === 'number' ? 'n' : 's' }; }));
        return ws;
      },
      book_new: () => ({}),
      book_append_sheet: (wb, ws, name) => { books[name] = ws; },
    },
    write: () => new Uint8Array([1]),
  };
};

test('exportXlsx: number formats — shares as %, money 2 dp with thousands, per-POD 2 dp, counts 0 dp; values stay numbers', async () => {
  const XLSX = cellXlsx();
  const s = sheets();
  await exportXlsx({ XLSX, downloads: { save: async () => ({ status: 'saved' }) }, sheets: s });
  const { Summary, Inputs, Personnel } = XLSX.books;
  const rowOf = (rows, pred) => rows.findIndex(pred) + 1;
  // Inputs: a share keeps its fraction and gets a percent format; a money scalar is left as typed
  const sepa = inputs.scalars.find((x) => x.key === 'paymentMixSepa');
  const r = rowOf(s.Inputs, (row) => row[1] === sepa.label);
  assert.deepEqual([Inputs[`C${r}`].v, Inputs[`C${r}`].t, Inputs[`C${r}`].z], [0.77, 'n', '0.0%']);
  const fee = rowOf(s.Inputs, (row) => row[1] === inputs.scalars.find((x) => x.key === 'recordingsPricePerMinute').label);
  assert.equal(Inputs[`C${fee}`].z, undefined);
  const nc = rowOf(s.Inputs, (row) => row[0] === 'New customers');
  assert.equal(Inputs[`B${nc}`].z, '#,##0');
  // Summary: € rows 2 dp with thousands (months and total), per-POD 2 dp, counts 0 dp, FTE 2 dp; text cells untouched
  const tot = rowOf(s.Summary, (row) => row[0] === 'TOTAL OPERATIONS COST');
  assert.equal(Summary[`D${tot}`].z, '#,##0.00');
  assert.equal(Summary[`P${tot}`].z, '#,##0.00');
  assert.equal(typeof Summary[`P${tot}`].v, 'number');
  assert.equal(Summary[`A${tot}`].z, undefined);
  assert.equal(Summary[`D${rowOf(s.Summary, (row) => /^CTS per POD per year - average/.test(row[0]))}`].z, '#,##0.00');
  assert.equal(Summary[`P${rowOf(s.Summary, (row) => row[0] === 'New customers')}`].z, '#,##0');
  assert.equal(Summary[`D${rowOf(s.Summary, (row) => /^Personnel FTE/.test(row[0]))}`].z, '0.00');
  assert.equal(Summary.D1.z, undefined); // header
  // Personnel: costs 2 dp with thousands, FTE 2 dp
  assert.equal(Personnel.G2.z, '0.00');
  for (const c of ['H', 'I', 'J', 'U', 'V']) assert.equal(Personnel[`${c}2`].z, '#,##0.00', c);
  assert.equal(Personnel.A2.z, undefined);
});
