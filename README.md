# CLAUDE.md – Operations Cost Plan 2027 artifact

## What this repo is
An interactive, shared web version of MET Retail's 2027 Operations Cost Plan, published as a claude.ai Artifact. Read in this order:
1. `SPEC.md` – what to build, scope, acceptance criteria
2. `CALCULATIONS.md` – every formula (source of truth together with the reference Excel)
3. `data/inputs.json`, `data/personnel.json` – seed data from the owner's v5 Excel
4. `tests/expected_v5.json` – golden results the engine must reproduce (±€0.01)
5. `reference/Operations_Cost_Plan_2027_v5.xlsx` – the original model

## Rules
- Do not change the calculation logic or invent inputs. If something in SPEC/CALCULATIONS is ambiguous, check the Excel formulas, then ask the owner.
- Keep the calculation engine a pure, framework-free JS module (`src/calc.js`) with no DOM or platform calls, so it can be unit-tested in Node and inlined into the page.
- Build step bundles everything into one self-contained HTML file (`dist/index.html`); only cdnjs scripts (exact versions) and Google Fonts may be external.
- Test-first: write the golden test against `tests/expected_v5.json` before implementing the engine.
- Before writing artifact runtime code (`claude.use("db" | "user" | "downloads")`), load the `artifact-capabilities` skill and follow its type definitions; before the first publish, load `artifact-design`. Apply `met-branding` if available.
- Seed the db after the first publish (ArtifactData batch writes from `data/*.json`), never hard-code the db contents in the page beyond the fallback seed.
- Shares are stored as fractions; show them as %.
- The user (Luca) prefers concise answers, recommendations with reasons, and to agree changes before they are made.

## Suggested layout
```
src/calc.js          pure engine: (inputs, roles) -> {lines, aggregates, unitEconomics}
src/ui/*.js          tabs: summary, inputs, personnel, readme
src/store.js         db wrapper (subscribe, debounced update, conflicts, read-only)
src/export.js        SheetJS export
tests/calc.test.js   golden test vs tests/expected_v5.json
build.mjs            inline everything into dist/index.html
```
