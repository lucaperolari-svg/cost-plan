// Excel export model: pure functions (no DOM). XLSX (SheetJS) and downloads are passed in.
import { calculate, summaryRows } from './calc.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabels = () => MONTHS.map((m) => `${m} 2027`);

// Excel number formats (values stay numbers): shares as %, money with thousands and 2 decimals, counts whole
export const Z = { share: '0.0%', money: '#,##0.00', perPod: '#,##0.00', count: '#,##0', fte: '0.00' };
const SUMMARY_Z = { eur: Z.money, eurPerPod: Z.perPod, count: Z.count, fte: Z.fte };
const isShare = (s) => typeof s.unit === 'string' && s.unit.startsWith('%');
// each sheet's rows carry a parallel, non-enumerable `formats` (row -> column -> format or undefined)
const withFormats = (rows, formats) => Object.defineProperty(rows, 'formats', { value: formats, enumerable: false });

export function buildSheets(inputs, roles, departments) {
  const result = calculate(inputs, roles, departments);

  const values = (z) => Array(13).fill(z); // 12 months + total
  const Summary = [['Line', 'Bucket', 'Fixed/Variable', ...monthLabels(), 'Total 2027']];
  const summaryZ = [[]];
  for (const r of summaryRows(result)) {
    Summary.push([r.label, r.bucket ?? '', r.fv ?? '', ...r.monthly, r.total]);
    summaryZ.push([, , , ...values(SUMMARY_Z[r.format] ?? Z.money)]);
  }

  const Inputs = [['Section', 'Label', 'Value', 'Unit', 'Note']];
  const inputsZ = [[]];
  for (const s of inputs.scalars) {
    Inputs.push([s.section, s.label, s.value, s.unit, s.note ?? '']);
    inputsZ.push(isShare(s) ? [, , Z.share] : []);
  }
  Inputs.push([], ['Monthly series', ...monthLabels()]);
  Inputs.push(['New customers', ...inputs.monthly.newCustomers]);
  Inputs.push(['CS platform licences', ...inputs.monthly.csLicences]);
  inputsZ.push([], [], [, ...Array(12).fill(Z.count)], [, ...Array(12).fill(Z.count)]);

  const Personnel = [['ID', 'Role', 'Department', 'Description', 'Start', 'End', 'FTE', 'Quarterly cost at 1 FTE', 'One-off hiring fee', ...monthLabels(), 'Total 2027']];
  const personnelZ = [[]];
  const costs = new Map(result.personnel.roles.map((p) => [p.id, p.cost]));
  for (const r of roles) {
    const c = costs.get(r.id) ?? { monthly: Array(12).fill(0), total: 0 };
    Personnel.push([r.id, r.role, r.department, r.description ?? '', r.start ?? '', r.end ?? '', r.fte, r.quarterlyCostAt1Fte, r.oneOffHiringFee, ...c.monthly, c.total]);
    personnelZ.push([, , , , , , Z.fte, Z.money, Z.money, ...values(Z.money)]);
  }
  return { Summary: withFormats(Summary, summaryZ), Inputs: withFormats(Inputs, inputsZ), Personnel: withFormats(Personnel, personnelZ) };
}

// A1 address of a 0-based row and column
const colName = (c) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// set each numeric cell's number format (SheetJS cell.z) after aoa_to_sheet
function applyFormats(ws, formats) {
  (formats || []).forEach((row, r) => (row || []).forEach((z, c) => {
    const cell = z && ws[`${colName(c)}${r + 1}`];
    if (cell && typeof cell.v === 'number') cell.z = z;
  }));
  return ws;
}

const UNAVAILABLE = new Set(['not_granted', 'capability_disabled', 'capability_removed', 'unavailable']);

export async function exportXlsx({ XLSX, downloads, sheets, filename = 'Operations_Cost_Plan_2027.xlsx' }) {
  if (!downloads) return 'unavailable';
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, applyFormats(XLSX.utils.aoa_to_sheet(rows), rows.formats), name);
  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  try {
    const res = await downloads.save({ filename, data });
    return res.status;
  } catch (e) {
    if (e?.code === 'declined') return 'declined';
    if (UNAVAILABLE.has(e?.code)) return 'unavailable';
    throw e;
  }
}
