# Operations Cost Plan 2027

An interactive, shared web version of MET Retail's 2027 Operations Cost Plan (v5 Excel), published as a claude.ai Artifact.

**Live page:** https://claude.ai/artifact/J6Tk7FRXDY6JiTvKNmPjph (private until shared from the page's Share menu; editors need the **Editor** level, everyone else sees it view-only)

Key check values (v5): total 2027 €1,216,931.37 · CTS per POD per year – December €641.32 average / €124.46 marginal · full year €1,854.40 / €127.16.

## Build and test
Requires Node 22.

```bash
npm install          # esbuild + playwright (dev only)
npm test             # unit tests: engine vs tests/expected_v5.json (±€0.01), validation, store, export
npm run build        # bundles everything into dist/index.html
npm run test:page    # builds, then drives the page in Chromium with a fake db
```

## Publish and seed
1. `npm run build`, then publish `dist/index.html` as an Artifact with capabilities
   `{db: {rules: [{path: "", read: "view", write: "admin"}]}, user: {}, downloads: true}`.
   Republishing to the same URL keeps the shared data.
2. Only for a new, empty artifact: `node scripts/seed-batch.mjs` prints the 15 ArtifactData `set` writes (13 roles, `plan/meta`, `plan/inputs`) built from `data/*.json`. Write `plan/inputs` last. Don't re-seed a live artifact: it would overwrite the team's edits.

## Contents
| Path | Purpose |
|---|---|
| `CLAUDE.md` | Instructions and rules for Claude Code |
| `SPEC.md` | Approved design: purpose, users, pages, data model, platform, acceptance criteria |
| `CALCULATIONS.md` | Every formula, tags, aggregates, unit economics |
| `data/inputs.json`, `data/personnel.json` | Seed data from the v5 Excel (43 assumptions, monthly series, 5 departments, 13 roles) |
| `reference/Operations_Cost_Plan_2027_v5.xlsx` | The source Excel model |
| `src/calc.js` | Pure calculation engine (no DOM), shared by the page, the export and the tests |
| `src/validate.js` | Number parsing and input checks |
| `src/store.js` | Wrapper over the shared `db`: live updates, per-field saves, read-only fallback |
| `src/export.js` | Excel export (SheetJS) |
| `src/ui/` | Page shell and the four tabs: Summary, Inputs, Personnel, Read Me |
| `src/page.html`, `src/styles.css`, `src/assets/` | Page template, styles, MET logos |
| `build.mjs` | Inlines everything into `dist/index.html` |
| `scripts/seed-batch.mjs` | Seed writes for a new artifact |
| `tests/` | Unit tests, Playwright page tests, golden results `expected_v5.json`, fake db |
| `docs/superpowers/plans/` | Implementation plan |
