// Prints the ArtifactData batch that seeds the db from data/*.json (15 entries).
import { readFileSync } from 'node:fs';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const inputs = read('inputs.json');
const { departments, roles } = read('personnel.json');
// like the page's writes: when, and by whom (null: seeded by Claude, not a viewer)
const stamp = { updatedAt: new Date().toISOString(), updatedBy: null };

const batch = [
  {
    op: 'set', collection: 'plan', doc_id: 'inputs',
    data: {
      monthly: inputs.monthly,
      scalars: Object.fromEntries(inputs.scalars.map((s) => [s.key, s.value])),
      ...stamp,
    },
  },
  { op: 'set', collection: 'plan', doc_id: 'meta', data: { departments } },
  ...roles.map((r) => ({ op: 'set', collection: 'roles', doc_id: r.id, data: { ...r, ...stamp } })),
];
console.log(JSON.stringify(batch, null, 2));
