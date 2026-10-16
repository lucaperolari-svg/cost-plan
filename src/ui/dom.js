// DOM helpers and number formats for the page. `fmt` is pure; `h` needs a document.

// h('button', {class: 'x', onclick: fn, hidden: true, dataset: {id: 1}}, 'text', child, [more])
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (k in el && typeof el[k] !== 'function' && !k.includes('-')) el[k] = v;
    else el.setAttribute(k, String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : String(c));
  };
  children.forEach(add);
  return el;
}

const DASH = '–';
const nf = new Map();
const num = (opts) => {
  const key = JSON.stringify(opts);
  if (!nf.has(key)) nf.set(key, new Intl.NumberFormat('en-IE', opts));
  return nf.get(key);
};
const guard = (f) => (n, ...rest) => (typeof n === 'number' && Number.isFinite(n) ? f(n, ...rest) : DASH);

export const fmt = {
  // 0 decimals in tables (default), 2 in tiles
  eur: guard((n, decimals = 0) => num({ style: 'currency', currency: 'EUR', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)),
  int: guard((n) => num({ maximumFractionDigits: 0 }).format(n)),
  // shares are stored as fractions
  pct: guard((n, maxDecimals = 2) => num({ style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: maxDecimals }).format(n)),
  fte: guard((n) => num({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)),
};
