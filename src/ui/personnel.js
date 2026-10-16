// Personnel tab: editable role table, monthly cost / FTE per role, department totals.
// renderPersonnel(container, state, actions) builds the DOM once per container and then updates rows in
// place, keyed by role id (fields keyed "R03:fte"), so focus and caret survive re-renders and remote
// snapshots. Number, text and date fields share the Inputs tab's draft/commit cycle (fields.js): they are
// written on blur or Enter, Esc undoes typing, refused numbers stay "not saved". The department select
// writes on change. Every write is actions.upsertRole(full role) or actions.deleteRole(id).
// Calculated values come from the committed state through calculate(), the same call as the Summary tab.
import { calculate, summaryRows, YEAR } from '../calc.js';
import { h, fmt } from './dom.js';
import { createFieldSet, numberInput, NOT_SAVED } from './fields.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUMBERS = [
  { field: 'fte', label: 'FTE', cls: 'pe-fte' },
  { field: 'quarterlyCostAt1Fte', label: 'Quarterly cost at 1 FTE', cls: 'pe-money' },
  { field: 'oneOffHiringFee', label: 'One-off hiring fee', cls: 'pe-money' },
];
const SPECS = {
  role: { type: 'text' }, description: { type: 'text' }, start: { type: 'date' }, end: { type: 'date' },
  fte: { type: 'number' }, quarterlyCostAt1Fte: { type: 'number' }, oneOffHiringFee: { type: 'number' },
};
const CONFIRM_MS = 4000;
const END_BEFORE_START = 'End date before start date: no salary is counted, but the one-off hiring fee is still booked in the start month (as in the Excel model).';
const NO_START = 'No start date — not counted';

const fieldKey = (id, field) => `${id}:${field}`;
const splitKey = (key) => { const i = key.lastIndexOf(':'); return { id: key.slice(0, i), field: key.slice(i + 1) }; };
const idNum = (id) => { const m = /^R(\d+)$/.exec(String(id)); return m ? Number(m[1]) : null; };
const byId = (a, b) => {
  const x = idNum(a.id), y = idNum(b.id);
  if (x !== null && y !== null) return x - y;
  if (x !== null || y !== null) return x !== null ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
};
export const nextRoleId = (roles) => `R${String(Math.max(0, ...roles.map((r) => idNum(r.id) ?? 0)) + 1).padStart(2, '0')}`;

const views = new WeakMap(); // container -> view

export function renderPersonnel(container, state, actions) {
  let v = views.get(container);
  if (!v || !container.contains(v.root)) {
    v = build(container, state);
    views.set(container, v);
  }
  v.state = state;
  v.actions = actions;
  update(v);
  return v;
}

export function destroyPersonnel(container) {
  const v = views.get(container);
  if (v?.confirm) clearTimeout(v.confirm.timer);
  views.delete(container);
}

const findRole = (v, id) => v.state.roles.find((r) => r.id === id);

// --- build (once per container)
function build(container, state) {
  const v = { root: null, rows: new Map(), confirm: null, pendingFocus: null, measure: 'cost', state, actions: null };
  v.f = createFieldSet({
    spec: (key) => SPECS[splitKey(key).field],
    value: (key) => { const { id, field } = splitKey(key); return findRole(v, id)?.[field]; },
    readOnly: () => !!v.state.readOnly,
    update: () => update(v),
    write: (key, value) => {
      const { id, field } = splitKey(key);
      const role = findRole(v, id);
      if (role) v.actions.upsertRole({ ...role, [field]: value });
    },
  });

  v.rolesBody = h('tbody');
  v.rolesFoot = h('tfoot');
  v.addBtn = h('button', { type: 'button', class: 'btn pe-add', onclick: () => addRole(v) }, 'Add role');
  const rolesHead = h('thead', {}, h('tr', {},
    h('th', { scope: 'col', class: 'col-label' }, 'ID · Role'),
    h('th', { scope: 'col' }, 'Department'),
    h('th', { scope: 'col' }, 'Description'),
    h('th', { scope: 'col' }, 'Start'),
    h('th', { scope: 'col' }, 'End'),
    NUMBERS.map((n) => h('th', { scope: 'col', class: 'num' }, n.label)),
    h('th', { scope: 'col', class: 'num pe-calc' }, `Avg FTE ${YEAR}`),
    h('th', { scope: 'col', class: 'num pe-calc' }, `Cost ${YEAR}`),
    h('th', { scope: 'col', class: 'pe-actions' }, h('span', { class: 'visually-hidden' }, 'Actions'))));
  const roles = h('section', { class: 'card', 'aria-labelledby': 'pe-roles-title' },
    h('div', { class: 'pe-head' },
      h('div', {},
        h('h2', { id: 'pe-roles-title', class: 'card-title' }, 'Roles'),
        h('p', { class: 'card-note' }, 'Changes save when you leave a field or press Enter; Esc undoes typing. A blank end date means open-ended; a role without a start date is not counted. Type whole numbers without thousands separators (16750); decimal comma or point both work (0,5 or 0.5).')),
      v.addBtn),
    h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'pe-roles-title' },
      h('table', { class: 'sum-table pe-table' }, rolesHead, v.rolesBody, v.rolesFoot)));

  v.monthlyBody = h('tbody');
  v.measureBtns = ['cost', 'fte'].map((m) => h('button', {
    type: 'button', class: 'seg-btn', dataset: { measure: m },
    onclick: () => { v.measure = m; update(v); },
  }, m === 'cost' ? 'Cost (€)' : 'FTE'));
  const monthHead = (first) => h('thead', {}, h('tr', {},
    h('th', { scope: 'col', class: 'col-label' }, first),
    MONTHS.map((m) => h('th', { scope: 'col', class: 'num' }, m)),
    h('th', { scope: 'col', class: 'num col-total' }, `Total ${YEAR}`)));
  const monthly = h('section', { class: 'card', 'aria-labelledby': 'pe-monthly-title' },
    h('div', { class: 'pe-head' },
      h('div', {},
        h('h2', { id: 'pe-monthly-title', class: 'card-title' }, 'Monthly by role'),
        h('p', { class: 'card-note' }, 'Calculated from the roles above: cost in € (salary pro rata to the days in role, plus the hiring fee in the start month) or FTE. FTE total = average of the 12 months.')),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, v.measureBtns)),
    h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'pe-monthly-title' },
      h('table', { class: 'sum-table' }, monthHead('Role'), v.monthlyBody)));

  v.deptBody = h('tbody');
  const depts = h('section', { class: 'card', 'aria-labelledby': 'pe-dept-title' },
    h('h2', { id: 'pe-dept-title', class: 'card-title' }, 'Totals by department'),
    h('p', { class: 'card-note' }, 'Cost per department feeds the Personnel block of the Summary; FTE total = average of the 12 months.'),
    h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'pe-dept-title' },
      h('table', { class: 'sum-table' }, monthHead('Department'), v.deptBody)));

  v.root = h('div', { class: 'personnel' }, roles, monthly, depts);
  container.replaceChildren(v.root);
  return v;
}

const COLS = 11; // columns of the role table

function buildRow(v, role) {
  const id = role.id;
  const r = { id, msgs: h('div', { class: 'pe-msgs' }) };
  const name = () => findRole(v, id)?.role || id;
  const text = (field, attrs) => v.f.wire(h('input', {
    type: 'text', autocomplete: 'off', class: `in-input pe-input pe-${field}`, dataset: { key: fieldKey(id, field) }, ...attrs,
  }), fieldKey(id, field));
  const date = (field, label) => v.f.wire(h('input', {
    type: 'date', min: '2000-01-01', max: '2099-12-31', class: 'in-input pe-input pe-date', dataset: { key: fieldKey(id, field) }, 'aria-label': label,
  }), fieldKey(id, field));

  r.roleInput = text('role', { placeholder: 'Role name', 'aria-label': `Role name, ${id}` });
  r.descInput = text('description', { placeholder: 'Description', 'aria-label': `Description, ${id}` });
  r.start = date('start', `Start date, ${id}`);
  r.end = date('end', `End date (blank = open), ${id}`);
  r.dept = h('select', { class: 'in-input pe-input pe-dept', dataset: { key: fieldKey(id, 'department') }, 'aria-label': `Department, ${id}` });
  r.dept.addEventListener('change', () => {
    const cur = findRole(v, id);
    if (cur && !v.state.readOnly && cur.department !== r.dept.value) v.actions.upsertRole({ ...cur, department: r.dept.value });
  });
  r.nums = NUMBERS.map((n) => v.f.wire(numberInput(fieldKey(id, n.field), { class: `in-input pe-input ${n.cls}`, 'aria-label': `${n.label}, ${id}` }), fieldKey(id, n.field)));
  r.fteTotal = h('td', { class: 'num pe-calc', dataset: { total: 'fte' } });
  r.costTotal = h('td', { class: 'num pe-calc', dataset: { total: 'cost' } });
  r.del = h('button', { type: 'button', class: 'pe-del', dataset: { delete: id }, onclick: () => onDelete(v, id) }, 'Delete');
  r.del.setAttribute('aria-label', `Delete ${id}`);
  r.tr = h('tr', { class: 'pe-row', dataset: { role: id } },
    h('th', { scope: 'row', class: 'col-label' }, h('span', { class: 'pe-id' }, id), r.roleInput),
    h('td', {}, r.dept), h('td', {}, r.descInput), h('td', {}, r.start), h('td', {}, r.end),
    r.nums.map((input) => h('td', { class: 'num' }, input)),
    r.fteTotal, r.costTotal,
    h('td', { class: 'pe-actions' }, r.del));
  r.msgTr = h('tr', { class: 'pe-msgrow', dataset: { roleMsg: id }, hidden: true }, h('td', { colspan: String(COLS) }, r.msgs));
  r.name = name;
  return r;
}

// --- actions
function addRole(v) {
  if (v.state.readOnly) return;
  const departments = v.state.departments || [];
  const id = nextRoleId(v.state.roles);
  v.actions.upsertRole({
    id, role: '', department: departments[0] ?? null, description: '',
    start: `${YEAR}-01-01`, end: null, fte: 1, quarterlyCostAt1Fte: 0, oneOffHiringFee: 0,
  });
  v.pendingFocus = id;
  update(v);
}

function onDelete(v, id) {
  if (v.state.readOnly) return;
  if (v.confirm?.id === id) {
    clearTimeout(v.confirm.timer);
    v.confirm = null;
    v.actions.deleteRole(id);
  } else {
    if (v.confirm) clearTimeout(v.confirm.timer);
    v.confirm = { id, timer: setTimeout(() => { v.confirm = null; update(v); }, CONFIRM_MS) };
  }
  update(v);
}

// --- update (every state change and every keystroke)
function rowMessages(v, role) {
  const out = [];
  for (const n of NUMBERS) {
    const key = fieldKey(role.id, n.field);
    const { n: val, amb } = v.f.status(key);
    const notSaved = v.f.rejected.has(key) ? NOT_SAVED : '';
    if (amb) out.push({ level: 'error', text: `${n.label}: ${amb}${notSaved}` });
    else if (Number.isNaN(val)) out.push({ level: 'error', text: `${n.label}: Not a number${notSaved}` });
    else if (typeof val === 'number' && val < 0) out.push({ level: 'error', text: `${n.label}: Value is below 0${notSaved}` });
  }
  if (!role.start) out.push({ level: 'warning', text: NO_START });
  else if (role.end && role.end < role.start) out.push({ level: 'warning', text: END_BEFORE_START });
  return out;
}

function syncRow(v, r, role, calc) {
  const ro = !!v.state.readOnly;
  for (const field of Object.keys(SPECS)) {
    const key = fieldKey(role.id, field);
    v.f.inputs.get(key).disabled = ro;
    v.f.sync(key);
  }
  for (const n of NUMBERS) {
    const key = fieldKey(role.id, n.field);
    const input = v.f.inputs.get(key);
    const { n: val, amb, draft } = v.f.status(key);
    const bad = !!amb || Number.isNaN(val) || (typeof val === 'number' && val < 0);
    input.classList.toggle('is-error', bad);
    input.classList.toggle('is-empty', !bad && (val === null || val === undefined || val === ''));
    input.classList.toggle('is-draft', draft);
    if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  r.descInput.title = role.description || '';
  // department select: the departments, plus the role's own value if it is not one of them
  const opts = [...(v.state.departments || [])];
  if (role.department && !opts.includes(role.department)) opts.push(role.department);
  const optKey = opts.join('\n');
  if (r.optKey !== optKey) {
    r.dept.replaceChildren(...opts.map((d) => h('option', { value: d }, d)));
    r.optKey = optKey;
    r.dept.value = role.department ?? '';
  }
  r.dept.disabled = ro;
  if (document.activeElement !== r.dept && r.dept.value !== (role.department ?? '')) r.dept.value = role.department ?? '';

  // warnings and field errors
  const msgs = rowMessages(v, role);
  const endWarn = msgs.some((m) => m.text === END_BEFORE_START);
  r.end.title = endWarn ? END_BEFORE_START : '';
  r.end.classList.toggle('is-warning', endWarn);
  r.start.classList.toggle('is-warning', !role.start);
  r.tr.classList.toggle('has-warning', msgs.some((m) => m.level === 'warning'));
  const sig = JSON.stringify(msgs);
  if (r.msgSig !== sig) {
    r.msgs.replaceChildren(...msgs.map((m) => h('p', { class: `field-msg is-${m.level}` }, m.text)));
    r.msgSig = sig;
  }
  r.msgTr.hidden = !msgs.length;

  r.fteTotal.textContent = fmt.fte(calc?.fte.total ?? 0);
  r.costTotal.textContent = fmt.int(calc?.cost.total ?? 0);
  r.del.hidden = ro;
  const confirming = v.confirm?.id === role.id;
  r.del.textContent = confirming ? 'Confirm delete' : 'Delete';
  r.del.classList.toggle('is-confirm', confirming);
  r.del.setAttribute('aria-label', confirming ? `Confirm delete ${r.name()}` : `Delete ${r.name()}`);
  r.roleInput.setAttribute('aria-label', `Role name, ${role.id}`);
}

function monthCells(values, total, f) {
  return [...values.map((n) => h('td', { class: n === 0 ? 'num zero' : 'num' }, f(n))),
    h('td', { class: total === 0 ? 'num col-total zero' : 'num col-total' }, f(total))];
}

function update(v) {
  const { state } = v;
  const ro = !!state.readOnly;
  const roles = [...state.roles].sort(byId);
  const result = calculate(state.inputs, state.roles, state.departments);
  const calcById = new Map(result.personnel.roles.map((p) => [p.id, p]));

  // role rows: create, drop, order (moving only rows out of place, so a focused field is not disturbed)
  const ids = new Set(roles.map((r) => r.id));
  for (const [id, r] of v.rows) {
    if (ids.has(id)) continue;
    for (const field of Object.keys(SPECS)) v.f.forget(fieldKey(id, field));
    r.tr.remove(); r.msgTr.remove();
    v.rows.delete(id);
    if (v.confirm?.id === id) { clearTimeout(v.confirm.timer); v.confirm = null; }
  }
  let at = 0;
  for (const role of roles) {
    let r = v.rows.get(role.id);
    if (!r) { r = buildRow(v, role); v.rows.set(role.id, r); }
    const kids = v.rolesBody.children;
    if (kids[at] !== r.tr) v.rolesBody.insertBefore(r.tr, kids[at] || null);
    if (kids[at + 1] !== r.msgTr) v.rolesBody.insertBefore(r.msgTr, kids[at + 1] || null);
    at += 2;
    syncRow(v, r, role, calcById.get(role.id));
  }
  const fte = result.keyFigures.fte, personnel = result.aggregates.subtotals.personnel;
  v.rolesFoot.replaceChildren(h('tr', { class: 'sum-subtotal' },
    h('th', { scope: 'row', class: 'col-label' }, `Total · ${roles.length} roles`),
    h('td', { colspan: '7' }),
    h('td', { class: 'num pe-calc' }, fmt.fte(fte.total)),
    h('td', { class: 'num pe-calc' }, fmt.int(personnel.total)),
    h('td', { class: 'pe-actions' })));
  v.root.classList.toggle('is-readonly', ro);
  v.addBtn.hidden = ro;
  if (v.pendingFocus && v.rows.has(v.pendingFocus)) {
    const input = v.rows.get(v.pendingFocus).roleInput;
    v.pendingFocus = null;
    if (!ro) { input.focus(); input.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  }

  // monthly by role
  const isCost = v.measure === 'cost';
  for (const b of v.measureBtns) b.setAttribute('aria-pressed', String(b.dataset.measure === v.measure));
  v.monthlyBody.replaceChildren(...roles.map((role) => {
    const c = calcById.get(role.id);
    const x = isCost ? c.cost : c.fte;
    return h('tr', { dataset: { roleMonthly: role.id, measure: v.measure } },
      h('th', { scope: 'row', class: 'col-label' },
        h('span', { class: 'row-label' }, h('span', { class: 'pe-id' }, role.id), ' ', role.role || h('span', { class: 'in-muted' }, 'Unnamed role')),
        h('span', { class: 'pe-sub' }, role.department ?? '')),
      monthCells(x.monthly, x.total, isCost ? fmt.int : fmt.fte));
  }));

  // totals by department: cost rows are the Summary personnel lines; FTE summed from the roles
  const deptRows = summaryRows(result).filter((r) => /^(r4[0-4]|dept:)/.test(r.row));
  const fteOf = (dep) => {
    const mine = result.personnel.roles.filter((p) => p.department === dep);
    const monthly = MONTHS.map((_, m) => mine.reduce((a, p) => a + p.fte.monthly[m], 0));
    return { monthly, total: monthly.reduce((a, b) => a + b, 0) / MONTHS.length };
  };
  const section = (label) => h('tr', { class: 'sum-section' }, h('th', { scope: 'rowgroup', class: 'col-label' }, label), h('td', { colspan: String(MONTHS.length + 1) }));
  const row = (dep, measure, label, x, f, cls) => h('tr', { class: cls, dataset: { dept: dep, measure } },
    h('th', { scope: 'row', class: 'col-label' }, h('span', { class: 'row-label' }, label)),
    monthCells(x.monthly, x.total, f));
  v.deptBody.replaceChildren(
    section('Cost (€)'),
    ...deptRows.map((r) => row(r.label, 'cost', r.label, r, fmt.int, 'sum-line')),
    row('total', 'cost', 'Total personnel cost', personnel, fmt.int, 'sum-subtotal'),
    section('FTE'),
    ...deptRows.map((r) => row(r.label, 'fte', r.label, fteOf(r.label), fmt.fte, 'sum-line')),
    row('total', 'fte', 'Total FTE', fte, fmt.fte, 'sum-subtotal'));
}
