// Excel export model: pure functions (no DOM). XLSX (SheetJS) and downloads are passed in.
import { calculate, summaryRows } from './calc.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabels = () => MONTHS.map((m) => `${m} 2027`);

export function buildSheets(inputs, roles, departments) {
  const result = calculate(inputs, roles, departments);

  const Summary = [['Line', 'Bucket', 'Fixed/Variable', ...monthLabels(), 'Total 2027']];
  for (const r of summaryRows(result)) Summary.push([r.label, r.bucket ?? '', r.fv ?? '', ...r.monthly, r.total]);

  const Inputs = [['Section', 'Label', 'Value', 'Unit', 'Note']];
  for (const s of inputs.scalars) Inputs.push([s.section, s.label, s.value, s.unit, s.note ?? '']);
  Inputs.push([], ['Monthly series', ...monthLabels()]);
  Inputs.push(['New customers', ...inputs.monthly.newCustomers]);
  Inputs.push(['CS platform licences', ...inputs.monthly.csLicences]);

  const Personnel = [['ID', 'Role', 'Department', 'Description', 'Start', 'End', 'FTE', 'Quarterly cost at 1 FTE', 'One-off hiring fee', ...monthLabels(), 'Total 2027']];
  const costs = new Map(result.personnel.roles.map((p) => [p.id, p.cost]));
  for (const r of roles) {
    const c = costs.get(r.id) ?? { monthly: Array(12).fill(0), total: 0 };
    Personnel.push([r.id, r.role, r.department, r.description ?? '', r.start ?? '', r.end ?? '', r.fte, r.quarterlyCostAt1Fte, r.oneOffHiringFee, ...c.monthly, c.total]);
  }
  return { Summary, Inputs, Personnel };
}

const UNAVAILABLE = new Set(['not_granted', 'capability_disabled', 'capability_removed', 'unavailable']);

export async function exportXlsx({ XLSX, downloads, sheets, filename = 'Operations_Cost_Plan_2027.xlsx' }) {
  if (!downloads) return 'unavailable';
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
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
