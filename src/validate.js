// Number parsing and input validation. Pure: no DOM, no platform calls.
import { deriveInputs } from './calc.js';

// Text -> number. ',' is decimal when alone or after the last '.'; otherwise ',' is a thousands separator.
export function parseNumber(text, { share = false } = {}) {
  if (typeof text === 'number') return Number.isFinite(text) ? (share ? text / 100 : text) : null;
  if (typeof text !== 'string') return null;
  let t = text.replace(/[\s ]/g, '').replace(/%$/, '');
  if (t === '') return null;
  const dot = t.lastIndexOf('.');
  const comma = t.lastIndexOf(',');
  if (comma > dot) t = t.replace(/\./g, '').replace(',', '.'); // 1.234,56 or 1,5
  else if (comma >= 0) t = t.replace(/,/g, ''); // 1,234.56
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return share ? n / 100 : n;
}

export const isShare = (scalar) => String(scalar?.unit ?? '').startsWith('%');

// 0.77 -> '77%', 0.017 -> '1.7%'
export const formatShare = (fraction) => `${Number((fraction * 100).toFixed(2))}%`;

const isEmpty = (v) => v === null || v === undefined || v === '';
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// -> [{key, level: 'error'|'warning'|'empty', message}]; `key` is a scalar key, 'newCustomers' or 'csLicences'.
export function validateInputs(inputs) {
  const issues = [];
  const add = (key, level, message) => issues.push({ key, level, message });
  const scalars = inputs?.scalars ?? [];
  const monthly = inputs?.monthly ?? {};

  for (const sc of scalars) {
    if (isEmpty(sc.value)) add(sc.key, 'empty', 'Required: empty is counted as 0');
    else if (!Number.isFinite(Number(sc.value))) add(sc.key, 'error', 'Not a number');
    else if (Number(sc.value) < 0) add(sc.key, 'error', 'Value is below 0');
    else if (isShare(sc) && Number(sc.value) > 1) add(sc.key, 'error', 'Share above 100%');
  }

  for (const key of ['newCustomers', 'csLicences']) {
    const arr = Array.isArray(monthly[key]) ? monthly[key] : [];
    if (arr.some(isEmpty)) add(key, 'empty', 'Some months are empty: counted as 0');
    if (arr.some((v) => !isEmpty(v) && !Number.isFinite(Number(v)))) add(key, 'error', 'Some months are not a number');
    else if (arr.some((v) => !isEmpty(v) && Number(v) < 0)) add(key, 'error', 'A month is below 0');
  }

  // AI + direct human call share must leave room for calls handled by neither (single issue on aiCallShare)
  const { d, errors } = deriveInputs({ scalars, monthly: { newCustomers: monthly.newCustomers ?? [] } });
  if (errors.length && !issues.some((x) => x.key === 'aiCallShare' && x.level === 'error'))
    add('aiCallShare', 'error', 'AI + direct human call share above 100%');

  if (scalars.some((s) => s.key === 'yearEndCustomerTarget') && Array.isArray(monthly.newCustomers)
      && !issues.some((x) => x.key === 'newCustomers' && x.level !== 'empty') && Math.round(d.newCustomersVsTarget) !== 0) {
    const total = monthly.newCustomers.reduce((a, v) => a + (Number(v) || 0), 0);
    const diff = Math.round(d.newCustomersVsTarget);
    add('newCustomers', 'warning', `Total ${fmt(total)} vs year-end target ${fmt(total - diff)} (${diff > 0 ? '+' : ''}${diff})`);
  }
  return issues;
}
