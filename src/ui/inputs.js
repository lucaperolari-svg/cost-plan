// Inputs tab: Section A (monthly series) and Section B (assumptions by section, in seed order),
// derived values read-only, inline checks.
// renderInputs(container, state, actions) builds the DOM once per container and then updates the
// existing inputs in place (keyed by data-key; "newCustomers:6" for monthly cells), so focus and caret
// survive re-renders. The focused input, and any input with uncommitted text, is never overwritten.
// Typing updates this tab's derived values and checks at once (a local draft overlay on top of state);
// the value is written with actions.setScalar / setMonthly on blur or Enter. Escape drops the draft.
import { isShare, formatShare, validateInputs } from '../validate.js';
import { deriveInputs } from '../calc.js';
import { h, fmt } from './dom.js';
import { createFieldSet, numberInput, isBlank, clean, grouped, parseField, ambiguity, blocked, NOT_SAVED } from './fields.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SERIES = [
  { name: 'newCustomers', label: 'New customers', unit: 'customers / month', total: true },
  { name: 'csLicences', label: 'CS platform licences', unit: 'licences / month', total: false },
];
// derived values, each shown read-only after the scalar it follows
const DERIVED = [
  { key: 'paymentMixCard', after: 'paymentMixSepa', label: 'Payment mix - Card / wallet', unit: '% of payments', share: true, note: '100% − SEPA share' },
  { key: 'sepaFeePerTx', after: 'sepaFeeCap', label: 'SEPA DD - fee per successful transaction', unit: 'per tx', note: 'Fixed fee + variable fee × average amount, capped when a cap is set' },
  { key: 'cardFeePerTx', after: 'cardFixedFee', label: 'Card / wallet - fee per transaction', unit: 'per tx', note: 'Fixed fee + variable fee × average amount' },
  { key: 'noHumanNoAiShare', after: 'directHumanCallShare', label: 'Calls handled by neither AI nor a human', unit: '% of calls', share: true, note: '100% − AI share − direct human share' },
];
const AI_HUMAN_CHECK = 'AI + human share above 100%';
const LEVEL = { error: 3, warning: 2, empty: 1 };

const monthlyKey = (name, i) => `${name}:${i}`;
const splitKey = (key) => { const [name, i] = key.split(':'); return { name, index: Number(i) }; };

const views = new WeakMap(); // container -> view

export function renderInputs(container, state, actions) {
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

export function destroyInputs(container) {
  views.delete(container);
}

// --- drafts
function overlay(inputs, drafts, specs, { validOnly }) {
  const out = {
    ...inputs,
    scalars: inputs.scalars.map((s) => ({ ...s })),
    monthly: Object.fromEntries(Object.entries(inputs.monthly).map(([k, a]) => [k, [...a]])),
  };
  for (const [key, text] of drafts) {
    const spec = specs.get(key);
    const n = ambiguity(text, spec.share) ? NaN : parseField(text, spec.share);
    if (validOnly && blocked(text, spec.share)) continue;
    if (spec.series) out.monthly[spec.series][spec.index] = n;
    else out.scalars.find((s) => s.key === key).value = n;
  }
  return out;
}

function stateValue(v, key) {
  const spec = v.specs.get(key);
  return spec.series ? v.state.inputs.monthly[spec.series]?.[spec.index] : v.state.inputs.scalars.find((s) => s.key === key)?.value;
}

// --- build (once per container)
function field(v, key, attrs) {
  return v.f.wire(numberInput(key, attrs), key);
}

function build(container, state) {
  const v = { root: null, specs: new Map(), msgs: new Map(), rows: new Map(), derived: new Map(), state, actions: null };
  v.f = createFieldSet({
    spec: (key) => v.specs.get(key),
    value: (key) => stateValue(v, key),
    readOnly: () => !!v.state.readOnly,
    update: () => update(v),
    write: (key, n) => {
      const spec = v.specs.get(key);
      if (spec.series) v.actions.setMonthly(spec.series, spec.index, n);
      else v.actions.setScalar(key, n);
    },
  });
  v.fields = v.f.inputs;
  v.drafts = v.f.drafts;
  v.rejected = v.f.rejected;
  let uid = 0;
  const id = (p) => `in-${p}-${++uid}`;

  // Section A
  const head = h('thead', {}, h('tr', {},
    h('th', { scope: 'col', class: 'col-label' }, 'Series'),
    MONTHS.map((m) => h('th', { scope: 'col', class: 'num' }, m)),
    h('th', { scope: 'col', class: 'num col-total' }, 'Total 2027')));
  const body = h('tbody', {}, SERIES.map((s) => {
    const cells = MONTHS.map((m, i) => {
      const key = monthlyKey(s.name, i);
      v.specs.set(key, { series: s.name, index: i, share: false });
      return h('td', { class: 'num' }, field(v, key, { 'aria-label': `${s.label}, ${m} 2027`, class: 'in-input in-cell' }));
    });
    const total = s.total ? h('span', { dataset: { check: `${s.name}Total` } }) : h('span', { class: 'in-muted', title: 'Monthly counts: no annual total' }, '–');
    v.derived.set(`${s.name}Total`, total);
    return h('tr', { dataset: { series: s.name } },
      h('th', { scope: 'row', class: 'col-label' }, h('span', { class: 'row-label' }, s.label), h('span', { class: 'in-unit' }, s.unit)),
      cells, h('td', { class: 'num col-total' }, total));
  }));
  const vsTarget = h('p', { class: 'in-check', dataset: { check: 'newCustomersVsTarget' }, role: 'status' });
  const seriesMsg = h('p', { class: 'field-msg', hidden: true, dataset: { seriesMsg: '' } });
  v.derived.set('newCustomersVsTarget', vsTarget);
  v.msgs.set('series', seriesMsg);
  const sectionA = h('section', { class: 'card', 'aria-labelledby': 'in-a-title' },
    h('h2', { id: 'in-a-title', class: 'card-title' }, 'A · Monthly inputs'),
    h('p', { class: 'card-note' }, 'New customers signed and CS platform licences in use, per month of 2027.'),
    h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'in-a-title' },
      h('table', { class: 'sum-table in-table' }, head, body)),
    vsTarget, seriesMsg);

  // Section B: scalars grouped by section, in seed order
  const sections = new Map();
  for (const sc of state.inputs.scalars) {
    if (!sections.has(sc.section)) sections.set(sc.section, []);
    sections.get(sc.section).push(sc);
  }
  const cards = [...sections].map(([name, scalars]) => {
    const titleId = id('sec');
    const rows = [];
    for (const sc of scalars) {
      const share = isShare(sc);
      v.specs.set(sc.key, { share });
      const inputId = id('f'), noteId = id('n'), msgId = id('m');
      const msg = h('p', { class: 'field-msg', id: msgId, hidden: true });
      v.msgs.set(sc.key, msg);
      const row = h('div', { class: 'in-row', dataset: { row: sc.key } },
        h('div', { class: 'in-label' },
          h('label', { for: inputId }, sc.label),
          sc.note ? h('p', { class: 'in-note', id: noteId }, sc.note) : null),
        h('div', { class: 'in-field' },
          field(v, sc.key, { id: inputId, 'aria-describedby': [sc.note ? noteId : '', msgId].filter(Boolean).join(' ') }),
          h('span', { class: 'in-unit' }, sc.unit),
          msg));
      v.rows.set(sc.key, row);
      rows.push(row);
      for (const d of DERIVED.filter((x) => x.after === sc.key)) rows.push(derivedRow(v, d, id));
    }
    return h('section', { class: 'card in-section', dataset: { section: name }, 'aria-labelledby': titleId },
      h('h3', { id: titleId, class: 'card-title' }, name),
      h('div', { class: 'in-rows' }, rows));
  });

  v.root = h('div', { class: 'inputs' },
    sectionA,
    h('div', { class: 'in-b-head' },
      h('h2', { class: 'in-b-title' }, 'B · Assumptions'),
      h('p', { class: 'card-note' }, 'Shares are entered in %. Type whole numbers without thousands separators (8334); decimal comma or point both work (1,5 or 1.5). Empty fields count as 0 and are marked “not filled”. Changes save when you leave the field or press Enter; Esc undoes typing.')),
    h('div', { class: 'in-sections' }, cards));
  container.replaceChildren(v.root);
  return v;
}

function derivedRow(v, d, id) {
  const labelId = id('dl');
  const out = h('output', { class: 'in-derived-value', dataset: { derived: d.key }, 'aria-labelledby': labelId });
  const check = h('p', { class: 'field-msg is-error', hidden: true }, d.key === 'noHumanNoAiShare' ? AI_HUMAN_CHECK : '');
  v.derived.set(d.key, out);
  if (d.key === 'noHumanNoAiShare') v.msgs.set('aiHumanCheck', check);
  return h('div', { class: 'in-row in-derived', dataset: { row: `derived:${d.key}` } },
    h('div', { class: 'in-label' },
      h('span', { id: labelId, class: 'in-derived-label' }, d.label, ' ', h('span', { class: 'tag' }, 'Derived')),
      h('p', { class: 'in-note' }, d.note)),
    h('div', { class: 'in-field' }, out, h('span', { class: 'in-unit' }, d.unit), check));
}

// --- update (every state change and every keystroke)
function setMsg(el, issue, notSaved) {
  el.hidden = !issue;
  el.textContent = issue ? (issue.level === 'empty' ? 'Not filled: counted as 0' : issue.message) + (notSaved ? NOT_SAVED : '') : '';
  el.className = `field-msg${issue ? ` is-${issue.level}` : ''}`;
}

function update(v) {
  const { state, drafts, specs } = v;
  const checked = overlay(state.inputs, drafts, specs, { validOnly: false }); // drafts as typed, for checks
  const preview = overlay(state.inputs, drafts, specs, { validOnly: true }); // drafts that would be written
  const top = new Map();
  for (const is of validateInputs(checked)) if (!top.has(is.key) || LEVEL[is.level] > LEVEL[top.get(is.key).level]) top.set(is.key, is);

  const cellMsgs = []; // ambiguous monthly cells
  for (const [key, input] of v.fields) {
    const spec = specs.get(key);
    input.disabled = !!state.readOnly;
    v.f.sync(key);
    const { n, amb } = v.f.status(key);
    const cellError = !!amb || (spec.series ? (Number.isNaN(n) || (typeof n === 'number' && n < 0)) : top.get(key)?.level === 'error');
    const empty = !cellError && isBlank(n);
    input.classList.toggle('is-error', cellError);
    input.classList.toggle('is-empty', empty);
    input.classList.toggle('is-draft', drafts.has(key));
    if (cellError) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    const issue = amb ? { level: 'error', message: amb } : top.get(key);
    if (!spec.series) setMsg(v.msgs.get(key), issue, v.rejected.has(key));
    else if (amb) cellMsgs.push(`${SERIES.find((x) => x.name === spec.series).label}, ${MONTHS[spec.index]}: ${amb}`);
  }

  // derived values and checks, from the preview
  const { d } = deriveInputs(preview);
  const set = (key, text) => { const el = v.derived.get(key); if (el.textContent !== text) el.textContent = text; };
  const pct = (n) => (Number.isFinite(n) ? formatShare(n) : '–');
  set('paymentMixCard', pct(d.paymentMixCard));
  set('noHumanNoAiShare', pct(d.noHumanNoAiShare));
  set('sepaFeePerTx', fmt.eur(d.sepaFeePerTx, 2));
  set('cardFeePerTx', fmt.eur(d.cardFeePerTx, 2));
  const aiHuman = deriveInputs(checked).errors.length > 0; // as typed, so the check shows while typing
  v.msgs.get('aiHumanCheck').hidden = !aiHuman;
  v.derived.get('noHumanNoAiShare').classList.toggle('is-error', aiHuman);

  const nc = checked.monthly.newCustomers || [];
  const total = nc.reduce((a, x) => a + (isBlank(x) ? 0 : Number(x)), 0);
  set('newCustomersTotal', fmt.int(total));
  const target = Number(preview.scalars.find((s) => s.key === 'yearEndCustomerTarget')?.value) || 0;
  const diff = total - target;
  const vs = v.derived.get('newCustomersVsTarget');
  const text = `New customers total ${fmt.int(total)} vs year-end target ${fmt.int(target)} · Difference vs target: ${Number.isFinite(diff) ? grouped.format(clean(diff)) : '–'}`;
  if (vs.textContent !== text) vs.textContent = text;
  vs.classList.toggle('is-warning', !(Number.isFinite(diff) && Math.abs(diff) < 1e-9));

  // series-level messages (errors first, then not filled)
  const seriesIssues = SERIES.map((s) => top.get(s.name) && top.get(s.name).level !== 'warning' ? { ...top.get(s.name), label: s.label } : null).filter(Boolean)
    .sort((a, b) => LEVEL[b.level] - LEVEL[a.level]);
  const msgs = cellMsgs.length ? cellMsgs : seriesIssues.map((i) => `${i.label}: ${i.message}`);
  const level = cellMsgs.length ? 'error' : seriesIssues[0]?.level;
  const unsaved = [...v.rejected].some((k) => specs.get(k)?.series);
  const sm = v.msgs.get('series');
  sm.hidden = !msgs.length;
  sm.textContent = msgs.join(' · ') + (msgs.length && unsaved ? NOT_SAVED : '');
  sm.className = `field-msg${level ? ` is-${level}` : ''}`;
}
