// Read Me tab: static, plain-English guide. renderReadme(container) builds it once; it holds no state.
// Content summarises SPEC §6.4/§8 and CALCULATIONS §1–10 and describes the page as built.
import { h } from './dom.js';

const sec = (id, title, note, ...body) => h('section', { class: 'card rm-section', 'aria-labelledby': id },
  h('h2', { id, class: 'card-title' }, title), note ? h('p', { class: 'card-note' }, note) : null, ...body);
const list = (items) => h('ul', { class: 'rm-list' }, items.map((i) => h('li', {}, i)));
const b = (t) => h('strong', {}, t);
const sub = (t) => h('h3', { class: 'rm-sub' }, t);
const defs = (rows) => h('dl', { class: 'rm-defs' }, rows.map(([t, d]) => [h('dt', {}, t), h('dd', {}, d)]));
const chip = (cls, text) => h('span', { class: `tag ${cls}` }, text);

export function renderReadme(container) {
  container.replaceChildren(h('div', { class: 'readme' },
    sec('rm-use', 'How to use', 'The plan is shared: everyone with the link sees the same saved numbers.',
      sub('Tabs'),
      list([
        [b('Summary'), ': headline figures, the monthly cost chart and the monthly table with Total 2027.'],
        [b('Inputs'), ': the monthly new-customer and CS-licence series, and the assumptions grouped by section.'],
        [b('Personnel'), ': one row per role, with monthly cost or FTE (switch at the top), totals by department.'],
        [b('Read Me'), ': this page.'],
      ]),
      sub('Who can edit'),
      p('Editors can change inputs and roles. Everyone else is a viewer: they see the same numbers, every field is disabled and the header shows “View only”. If the shared data cannot be reached, the page shows the original v5 numbers, also as view only.'),
      sub('Editing and saving'),
      list([
        'Changes save when you leave a field or press Enter. Esc undoes what you typed. The header shows Saving…, then Saved.',
        'Everyone sees changes live, and every result recalculates at once.',
        'Shares are typed as % (15 or 15%) and stored as fractions.',
        'Type whole numbers without thousands separators (8334). Decimal comma or point both work (1,5 or 1.5).',
        'An ambiguous entry such as 2,000 is refused, not guessed: write 2000 for two thousand, or 2 for two. A refused entry keeps your text and is marked “not saved”.',
        'Delete on a role asks you to confirm: press Delete, then Confirm delete.',
        [b('Download Excel'), ' (top right) saves the current values as Operations_Cost_Plan_2027.xlsx with the sheets Summary, Inputs and Personnel. It contains values, not formulas, and viewers can use it too.'],
      ]),
      sub('Colours and markers'),
      list([
        [chip('', 'Derived'), ' Grey tag: a read-only value worked out from other inputs, for example the card share or the fee per transaction.'],
        ['A dashed field with a yellow tint and “not filled”: the field is empty and counts as 0.'],
        ['Red text or a red outline: an error (for example AI + human share above 100%, or a refused entry). Amber text or a yellow bar: a warning (for example a role whose end date is before its start date).'],
        ['Disabled, plain fields: you are in view-only mode.'],
        [chip('tag-bucket', 'CTS Ops'), ' ', chip('tag-bucket', 'CTS Care'), ' ', chip('tag-bucket', 'Outside CTS'), ' Grey tags on the Summary: the bucket of each line.'],
        [chip('tag-fv tag-fixed', 'Fixed'), ' ', chip('tag-fv tag-variable', 'Variable'), ' Tags with a petrol square (Fixed) or a yellow square (Variable).'],
        ['In the chart, petrol bars are fixed cost, yellow bars are variable cost and the teal line is active PODs.'],
      ])),

    sec('rm-defs', 'Definitions', null,
      defs([
        ['CTS average', 'Cost to serve per POD per year: all CTS cost (CTS Operations plus CTS Customer care) divided by active PODs. Shown with its split into Operations and Customer care.'],
        ['CTS marginal', 'The same, but only the variable CTS cost. It is what one more POD costs to serve, because fixed cost does not grow with PODs.'],
        ['Fixed/Variable', 'Every Summary line is tagged Fixed or Variable. Variable lines grow with customers, PODs, payments or calls; fixed lines (personnel, CS platform licences, phone numbers, the Haulogy fixed fee, the pricing connector platform) do not.'],
        ['Buckets', 'Each line belongs to one bucket. CTS Operations: payments, communications, Haulogy, Equifax and the personnel of Operations & Service, Billing & Invoicing and Switching & Metering. CTS Customer care: customer service, CS platform and the Customer Service personnel.'],
        ['Outside CTS', 'Costs left out of cost to serve: the pricing connector platform and the Pricing & Risk Management personnel. They are in the total but not in CTS.'],
        ['PODs', 'Points of delivery, the metering points that are supplied. Active PODs = active customers × PODs per customer.'],
        ['FTE', 'Full-time equivalent. A role counts for the share of each month it is active, so a role starting mid-month counts partly.'],
      ])),

    sec('rm-calc', 'Calculation logic', 'All amounts are in EUR. The reference is the Excel model v5; the page reproduces it. Every line also has a Total 2027, the sum of the months.',
      sub('1. Derived inputs'),
      p('Card share = 1 − SEPA share. Share of calls with no human and no AI = 1 − AI share − direct human share (it must not be negative). The SEPA fee per payment = fixed fee + variable % × average payment, capped at the SEPA fee cap when a cap is set. The card fee per payment = fixed fee + variable % × average payment. The Inputs tab also shows the difference between total new customers and the year-end target; 0 means the phasing matches.'),
      sub('2. Customer base'),
      p('Active customers each month = previous month + new customers, starting from the opening active customers. PODs = active customers × PODs per customer. In the Total column both show the December value.'),
      sub('3. Payments'),
      p('Payments = active customers × payments per customer per month + new customers × starting payments per new customer. They split into SEPA and card by the payment mix. Commissions = payments × fee per payment. Failed payments = payments × failure rate for each method. Retry fees = SEPA failed-debit fees, plus retries per failed payment × fee per payment (SEPA and card). Stripe Billing = retried volume × its percentage; it applies to retried payments only, not to first attempts.'),
      sub('4. Customer communications'),
      p('Invoices = active customers × invoices per customer per month. Paper invoices = invoices × paper share. Printing and enveloping and postage are charged per paper invoice. SMS = active customers × SMS per customer × price per SMS.'),
      sub('5. Customer service'),
      p('Calls = active customers × inbound calls per customer per month, on three paths: AI, direct to a human, and no human and no AI. A share of AI calls escalates to a human. Cost of contact applies to AI and no-human calls; AI calls carry their own fee on top; human calls are charged per minute (plus recordings and transcripts per minute) with no cost of contact. An escalated AI call therefore pays the cost of contact, the AI call fee and its human minutes. Outbound calls = active customers × calls × minutes × price per minute. Disputes = active customers × disputes per customer × cost per dispute.'),
      sub('6. CS platform and platforms'),
      p('CS platform licences = licences in the month × price per licence. Phone numbers = number of numbers × monthly fee, every month. Haulogy POD fees = PODs × fee per POD. The Haulogy fixed fee is charged every month from January. Equifax checks = new customers × one check at sign-up. The pricing connector platform = yearly licence ÷ 12 every month.'),
      sub('7. Personnel'),
      p('A role’s FTE in a month = FTE × the share of calendar days it is active in that month (start and end dates included). A role without a start date is not counted; a blank end date means open-ended. Monthly cost = quarterly cost at 1 FTE ÷ 3 × that month’s FTE, plus the one-off hiring fee in the month the start date falls. A role that started before 2027 books no hiring fee in 2027.'),
      p(b('End date before start date: '), 'the role has no salary cost, but the hiring fee is still booked in the start month, as in the Excel model. The Personnel tab shows a warning on that row. Department lines on the Summary add up the roles of each department; the FTE key figure in the Total column is the average of the 12 months.'),
      sub('8. Tags'),
      p('Buckets and Fixed/Variable tags are fixed per line, as in Definitions above.'),
      sub('9. Totals and checks'),
      p('Block subtotals add up their lines and TOTAL OPERATIONS COST adds the six blocks. Variable plus fixed equals the total, and CTS plus Outside CTS equals the total.'),
      sub('10. Unit economics (€ per POD per year)'),
      p('Each month: that month’s cost × 12 ÷ active PODs (0 if there are no PODs). The Total 2027 column: the year’s cost ÷ the average PODs of the 12 months. The lines are CTS average, of which Operations, of which Customer care, and CTS marginal (variable CTS cost only).'),
      p(b('The December column is the steady-state view: '), 'in the v5 data PODs only start in July, so earlier months and the full-year column are not comparable with a full run-rate.')),
  ));
}

function p(...c) { return h('p', { class: 'rm-p' }, ...c); }
