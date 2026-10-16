import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNumber, isShare, validateInputs, formatShare } from '../src/validate.js';

const seed = () => JSON.parse(readFileSync(new URL('../data/inputs.json', import.meta.url)));
const withScalar = (key, value) => {
  const i = seed();
  i.scalars.find((s) => s.key === key).value = value;
  return i;
};
const forKey = (issues, key) => issues.filter((x) => x.key === key);

test('parseNumber: decimal and thousands separators', () => {
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber('1,234'), 1.234);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('1.5'), 1.5);
  assert.equal(parseNumber(' 1 234,5 '), 1234.5);
  assert.equal(parseNumber('-2,5'), -2.5);
});

test('parseNumber: shares and invalid input', () => {
  assert.equal(parseNumber(' 15 % ', { share: true }), 0.15);
  assert.equal(parseNumber('15', { share: true }), 0.15);
  assert.equal(parseNumber('15%'), 15);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('   '), null);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber('1,2,3'), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(undefined), null);
});

test('isShare and formatShare', () => {
  assert.equal(isShare({ unit: '% of payments' }), true);
  assert.equal(isShare({ unit: 'EUR / tx' }), false);
  assert.equal(formatShare(0.77), '77%');
  assert.equal(formatShare(0.017), '1.7%');
  assert.equal(formatShare(0.007), '0.7%');
  assert.equal(formatShare(0), '0%');
});

test('validateInputs: seed is clean', () => {
  assert.deepEqual(validateInputs(seed()), []);
});

test('validateInputs: AI + human share above 100%', () => {
  const issues = validateInputs(withScalar('aiCallShare', 0.9));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'aiCallShare');
  assert.equal(issues[0].level, 'error');
  assert.match(issues[0].message, /above 100%/);
});

test('validateInputs: share above 100% and negatives', () => {
  const a = forKey(validateInputs(withScalar('paymentMixSepa', 1.2)), 'paymentMixSepa');
  assert.equal(a.length, 1);
  assert.equal(a[0].level, 'error');
  assert.match(a[0].message, /above 100%/);
  const b = forKey(validateInputs(withScalar('pricePerSms', -1)), 'pricePerSms');
  assert.equal(b.length, 1);
  assert.equal(b[0].level, 'error');
  assert.match(b[0].message, /below 0/);
});

test('validateInputs: null scalar is empty only', () => {
  const issues = validateInputs(withScalar('pricePerSms', null));
  assert.deepEqual(issues.map((x) => [x.key, x.level]), [['pricePerSms', 'empty']]);
});

test('validateInputs: monthly checks', () => {
  const i = seed();
  i.monthly.newCustomers[6] = 0;
  const w = validateInputs(i);
  assert.equal(w.length, 1);
  assert.equal(w[0].key, 'newCustomers');
  assert.equal(w[0].level, 'warning');
  assert.match(w[0].message, /-333/);
  const j = seed();
  j.monthly.csLicences[2] = null;
  j.monthly.newCustomers[0] = -5;
  const r = validateInputs(j);
  assert.ok(r.some((x) => x.key === 'csLicences' && x.level === 'empty'));
  assert.ok(r.some((x) => x.key === 'newCustomers' && x.level === 'error' && /below 0/.test(x.message)));
});

test('validateInputs: tolerates missing parts', () => {
  assert.doesNotThrow(() => validateInputs({}));
  assert.doesNotThrow(() => validateInputs({ scalars: [], monthly: {} }));
});
