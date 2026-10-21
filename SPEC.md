# Operations Cost Plan 2027 – interactive artifact: specification

Owner: Luca Perolari (MET Retail, Operations). Status: design approved in chat on 16 Oct 2026; this spec is the build reference.

## 1. Purpose

A shared, interactive web version of the **2027 Operations Cost Plan** (Excel `reference/Operations_Cost_Plan_2027_v5.xlsx`) for the MET Retail B2C energy & utilities Operations team.

- Everyone the page is shared with sees **the same saved plan**.
- Editors change inputs and personnel on the page; results recalculate instantly and the change is saved for everyone.
- The page must reproduce the Excel results exactly (see §7).

### Success criteria
1. With the seed data in `data/`, every Summary line matches `tests/expected_v5.json` within €0.01 per month.
2. An editor can change any input or role and every result updates without reload; a viewer without edit rights sees the plan read-only.
3. Changes are persisted and visible to other viewers (live).
4. A "Download Excel" button exports the current plan (values).

## 2. Users and access

| Who | Can |
|---|---|
| Editors (Luca, leadership colleague) | View, edit inputs and personnel |
| Viewers the page is shared with | View only (inputs shown disabled) |

## 3. Out of scope (do not build)
- Link / sync with the HR Dashboard artifact (dropped by the owner).
- Scenarios (Base/Low/High) – one plan only; what-ifs = change a cell.
- Cost to Acquire (CTA) – not part of these costs.
- Comments, edit history, approvals.

## 4. Platform

Published as a **claude.ai Artifact**: a single self-contained HTML page (inline CSS/JS). Constraints:
- External scripts only from `cdnjs.cloudflare.com` (pinned exact versions, e.g. SheetJS `xlsx@0.18.5`, Chart.js `4.4.1`); fonts from Google Fonts only.
- Runtime capabilities (declared at publish): `db` (shared data), `user` (who can edit), `downloads` (Excel export). Reach them with `await claude.use("db")` etc.; each may resolve `null` → page must still render (read-only, from bundled seed data).
- db access rules: read = `view`, write = `admin` (editors).
- Data is seeded into the db **after** first publish (never hard-coded as the source of truth); the page handles an empty db by falling back to the bundled seed so it is never blank.
- Light and dark mode; works at phone width (16 px side gutter, tables scroll horizontally inside their own container).
- MET corporate identity (colours, fonts) – apply the `met-branding` skill if available in the Claude Code session.

## 5. Data model (db)

| Path | Content |
|---|---|
| `plan/inputs` (doc) | `{monthly: {newCustomers[12], csLicences[12]}, scalars: {key: value}, updatedAt, updatedBy}` – keys exactly as in `data/inputs.json` |
| `roles/{id}` (docs) | one doc per role: fields as in `data/personnel.json` |
| `plan/meta` (doc) | `{departments: [5 names]}` |

Writes: one field change → one `update` of `plan/inputs` (debounced ~600 ms) that carries just that field (`{scalars: {key: value}}` merges only that key); a monthly series is written as a whole 12-month array, which replaces only that array. Last save wins on the same field, and a focused input is never overwritten by a remote change (Decision 2, agreed 16 Oct 2026; the `db` capability has no version-pinned writes). Roles: add / update / delete per doc.

## 6. Pages (tabs)

### 6.1 Summary
- **Headline tiles**: Total 2027 operations cost; December CTS per POD per year (average); December CTS marginal; Fixed vs variable share of 2027.
- **Monthly table** (Jan–Dec 2027 + Total 2027), same rows as Excel Summary:
  1. Payments & collections – SEPA DD commissions; Card/wallet commissions; Payment retries – transaction fees; Payment retries – Stripe Billing; subtotal
  2. Customer communications – Paper invoices printing & enveloping; Paper invoices postage; SMS; subtotal
  3. Customer service – Cost of contact (AI + no human); AI calls; Inbound calls – human; Recordings & transcripts; Outbound calls; Dispute resolution; subtotal
  4. CS platform – CS platform licences; Phone numbers; subtotal
  5. Platforms & market services – Haulogy POD fees; Haulogy fixed monthly fee; Pricing connector platform; Equifax customer checks; subtotal
  6. Personnel – one line per department (5); subtotal
  - TOTAL OPERATIONS COST
  - Each line shows its **CTS bucket** and **Fixed/Variable** tag (see CALCULATIONS.md §6).
- **Fixed / variable split** rows; **Cost by bucket** rows (CTS – Operations, CTS – Customer care, Total CTS, of which variable, Outside CTS); **Key figures** (new customers, active PODs, payments, FTE); **Unit economics** (CTS per POD per year: average, of which Operations, of which Customer care, marginal).
- **Chart**: monthly total cost as stacked bars fixed vs variable (Chart.js), with active PODs as a line on a second axis.

### 6.2 Inputs
- Section A – monthly inputs: New customers (12 cells + total), CS platform licences (12 cells).
- Section B – assumptions grouped by section exactly as `data/inputs.json` (label, editable value, unit, note).
- Derived values shown read-only (card share, no-human share, SEPA fee per tx, card fee per tx).
- Inline checks: "Difference vs year-end target" (new customers total − target); "AI + human share above 100%" error; percent fields entered as % and stored as fractions.
- Validation: numbers ≥ 0; shares 0–100%; empty = 0 but flagged visually as "not filled".

### 6.3 Personnel
- Editable table: ID, Role, Department (dropdown of 5), Description, Start date, End date (blank = open), FTE, Quarterly cost at 1 FTE, One-off hiring fee; add / delete row.
- Calculated per role: monthly FTE and monthly cost (Jan–Dec), total 2027.
- Totals by department (cost and FTE per month) – these feed Summary block 6.

### 6.4 Read Me
How to use the page, colour/interaction conventions, definitions (CTS average, CTS marginal, fixed/variable, buckets, outside CTS) and the calculation logic summary from CALCULATIONS.md.

## 7. Verification (required before handover)
1. Unit tests for the calculation engine (pure JS module) using `data/*.json` as input and `tests/expected_v5.json` as expected output – all Summary lines, all 12 months + total, tolerance €0.01; per-role personnel cost too.
2. Edge cases: all-zero inputs → no NaN/Infinity (CTS per POD = 0 when PODs = 0); end date before start → no salary, but the one-off hiring fee is still booked in the start month, as in the Excel (Decision 1, agreed 16 Oct 2026); start before 2027 → hiring fee not booked in 2027.
3. After publish: seed the db, reload, confirm Summary total = €1,216,931.37 and Dec CTS average = €641.32 / marginal = €124.46; confirm a view-level reader cannot write.

## 8. Excel export
"Download Excel" (editors and viewers) → `.xlsx` with sheets Summary, Inputs, Personnel containing current **values** (no formulas), generated client-side with SheetJS and saved through the `downloads` capability.
