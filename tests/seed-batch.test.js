import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/seed-batch.mjs', import.meta.url));

test('seed batch: 15 set entries; plan/inputs and every role carry updatedAt (ISO) and updatedBy null', () => {
  const before = Date.now();
  const batch = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' }));
  assert.equal(batch.length, 15);
  assert.ok(batch.every((e) => e.op === 'set'));
  const stamped = batch.filter((e) => (e.collection === 'plan' && e.doc_id === 'inputs') || e.collection === 'roles');
  assert.equal(stamped.length, 14);
  for (const e of stamped) {
    assert.equal(e.data.updatedBy, null, e.doc_id);
    assert.match(e.data.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/, e.doc_id);
    assert.ok(Date.parse(e.data.updatedAt) >= before - 1000, e.doc_id);
  }
  const meta = batch.find((e) => e.collection === 'plan' && e.doc_id === 'meta');
  assert.equal(meta.data.departments.length, 5);
});
