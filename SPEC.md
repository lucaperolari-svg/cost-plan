# Operations Cost Plan 2027 – handoff pack for Claude Code

Copy this folder into a new repository and start Claude Code there. Then give it this prompt:

> Read CLAUDE.md, SPEC.md and CALCULATIONS.md. Propose an implementation plan, then build the Operations Cost Plan artifact test-first: the calculation engine must reproduce tests/expected_v5.json within €0.01 before any UI work. Ask me before changing scope.

## Contents
| File | Purpose |
|---|---|
| `CLAUDE.md` | Instructions and rules for Claude Code |
| `SPEC.md` | Approved design: purpose, users, pages, data model, platform, acceptance criteria |
| `CALCULATIONS.md` | Every formula, tags, aggregates, unit economics |
| `data/inputs.json` | All inputs from the v5 Excel (43 assumptions + monthly new customers and licences) |
| `data/personnel.json` | 5 departments and the 13 roles from the v5 Personnel sheet |
| `tests/expected_v5.json` | Golden results: every Summary line per month + total, and each role's monthly FTE and cost |
| `reference/Operations_Cost_Plan_2027_v5.xlsx` | The source Excel model |

Key check values (v5): total 2027 €1,216,931.37 · CTS per POD per year – December €641.32 average / €124.46 marginal · full year €1,854.40 / €127.16.
