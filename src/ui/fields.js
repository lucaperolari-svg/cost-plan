// Editable fields shared by the Inputs and Personnel tabs: parsing, display and the draft/commit cycle.
// A field set keeps, per field key, the text typed but not yet written (drafts), the drafts refused on
// commit (rejected: shown "not saved") and the focused key. Typing makes a draft; blur or Enter commits it
// (a blocked draft keeps its text and writes nothing); Escape drops it. The caller's update() must never
// overwrite a field that has a draft or focus (sync() does that), so remote snapshots cannot clobber typing.
// Number fields show grouped values ("16,750") when unfocused and raw ones ("16750") while editing, and
// refuse unparseable, negative, share > 100% and ambiguous thousands/decimal text ("8,334") in non-share fields.
import { parseNumber, formatShare, ambiguousNumber } from '../validate.js';
import { h } from './dom.js';

export const isBlank = (v) => v === null || v === undefined || v === '';
export const clean = (n) => Number(n.toPrecision(12)); // drop float noise such as 0.30000000000000004
export const grouped = new Intl.NumberFormat('en-IE', { maximumFractionDigits: 6 });
// shown when the field is not focused: shares as %, others with grouping
export const display = (v, share) => (isBlank(v) ? '' : !Number.isFinite(Number(v)) ? String(v) : share ? formatShare(Number(v)) : grouped.format(clean(Number(v))));
// shown while editing: no grouping, so the text parses back to the same number
export const raw = (v, share) => (isBlank(v) ? '' : !Number.isFinite(Number(v)) ? String(v) : share ? formatShare(Number(v)) : String(clean(Number(v))));
// text -> null (empty) | NaN (not a number) | number
export const parseField = (text, share) => (text.trim() === '' ? null : parseNumber(text, { share }) ?? NaN);
export const outOfRange = (n, share) => typeof n === 'number' && (n < 0 || (share && n > 1));
// non-share fields only: '8,334' could be 8334 or 8.334, so it is refused with both readings
export const ambiguity = (text, share) => {
  const a = !share && ambiguousNumber(text);
  return a ? `Ambiguous: ${a.integer} or ${a.decimal}? Type ${a.integer}, or ${a.decimal.toFixed(4)} for decimals` : null;
};
export const blocked = (text, share) => { const n = parseField(text, share); return Number.isNaN(n) || outOfRange(n, share) || !!ambiguity(text, share); };
export const NOT_SAVED = ' — not saved';

const str = (v) => (isBlank(v) ? '' : String(v));
const TYPES = {
  number: {
    display: (v, s) => display(v, s.share),
    raw: (v, s) => raw(v, s.share),
    parse: (t, s) => parseField(t, s.share),
    blocked: (t, s) => blocked(t, s.share),
    same: (cur, n) => (isBlank(cur) && n === null) || (n !== null && !isBlank(cur) && Number(cur) === n),
  },
  text: { display: str, raw: str, parse: (t) => t.trim(), blocked: () => false, same: (cur, t) => str(cur) === t },
  date: { display: str, raw: str, parse: (t) => t || null, blocked: () => false, same: (cur, t) => (isBlank(cur) ? null : cur) === t },
};

// The text input used for numbers in both tabs.
export function numberInput(key, attrs = {}) {
  const input = h('input', {
    type: 'text', inputmode: 'decimal', autocomplete: 'off',
    class: 'in-input', dataset: { key }, placeholder: 'not filled', ...attrs,
  });
  input.spellcheck = false;
  return input;
}

// spec(key) -> {type: 'number' (default) | 'text' | 'date', share}; value(key) -> committed value;
// write(key, parsed) on a real change; readOnly() -> no writes; update() re-renders the caller's view.
export function createFieldSet({ spec, value, write, readOnly, update }) {
  const fs = { inputs: new Map(), drafts: new Map(), rejected: new Set(), focused: null };
  const kind = (key) => { const s = spec(key) || {}; return { s, t: TYPES[s.type || 'number'] }; };

  // the field's state as typed: {draft, n (parsed draft or committed value), amb (ambiguity message)}
  fs.status = (key) => {
    const { s, t } = kind(key);
    if (!fs.drafts.has(key)) return { draft: false, n: value(key), amb: null };
    const text = fs.drafts.get(key);
    return { draft: true, n: t.parse(text, s), amb: (s.type || 'number') === 'number' ? ambiguity(text, s.share) : null };
  };
  // put the committed value into an idle field (never one with a draft or focus)
  fs.sync = (key) => {
    const input = fs.inputs.get(key);
    if (!input || fs.drafts.has(key) || fs.focused === key) return;
    const { s, t } = kind(key);
    const next = t.display(value(key), s);
    if (input.value !== next) input.value = next;
  };
  fs.commit = (key) => {
    if (!fs.drafts.has(key)) return;
    const { s, t } = kind(key);
    const text = fs.drafts.get(key);
    // keep the text and its error, write nothing, mark it not saved
    if (t.blocked(text, s)) { fs.rejected.add(key); update(); return; }
    const n = t.parse(text, s);
    fs.drafts.delete(key);
    fs.rejected.delete(key);
    if (!t.same(value(key), n) && !readOnly()) write(key, n);
    update();
  };
  fs.forget = (key) => {
    fs.inputs.delete(key); fs.drafts.delete(key); fs.rejected.delete(key);
    if (fs.focused === key) fs.focused = null;
  };
  fs.wire = (input, key) => {
    fs.inputs.set(key, input);
    input.addEventListener('focus', () => {
      fs.focused = key;
      if (fs.drafts.has(key)) return;
      const { s, t } = kind(key);
      const next = t.raw(value(key), s);
      if (input.value === next) return;
      // swapping "8,334" for "8334" must keep a select-all (Tab focus, select-then-type), or typing would append
      const all = input.value.length > 0 && input.selectionStart === 0 && input.selectionEnd === input.value.length;
      input.value = next;
      if (all) input.select();
    });
    input.addEventListener('input', () => { fs.drafts.set(key, input.value); fs.rejected.delete(key); update(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); fs.commit(key); }
      else if (e.key === 'Escape' && fs.drafts.has(key)) {
        fs.drafts.delete(key);
        fs.rejected.delete(key);
        const { s, t } = kind(key);
        input.value = t.raw(value(key), s);
        update();
      }
    });
    input.addEventListener('blur', () => {
      fs.commit(key);
      if (fs.focused === key) fs.focused = null;
      update();
    });
    return input;
  };
  return fs;
}
