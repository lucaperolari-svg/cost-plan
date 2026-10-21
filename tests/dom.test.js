import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt } from '../src/ui/dom.js';

test('fmt.eur: en-IE euros, 0 decimals by default, 2 on request', () => {
  assert.equal(fmt.eur(1234567.891), '€1,234,568');
  assert.equal(fmt.eur(1234.5, 2), '€1,234.50');
  assert.equal(fmt.eur(-50), '-€50');
  assert.equal(fmt.eur(0), '€0');
});
test('fmt.int, fmt.pct (fraction -> %), fmt.fte', () => {
  assert.equal(fmt.int(12345.6), '12,346');
  assert.equal(fmt.pct(0.15), '15%');
  assert.equal(fmt.pct(0.0275), '2.75%');
  assert.equal(fmt.fte(1), '1.00');
  assert.equal(fmt.fte(0.125), '0.13');
});
test('fmt: missing values show a dash', () => {
  for (const f of [fmt.eur, fmt.int, fmt.pct, fmt.fte]) {
    assert.equal(f(null), '–');
    assert.equal(f(undefined), '–');
    assert.equal(f(NaN), '–');
  }
});
