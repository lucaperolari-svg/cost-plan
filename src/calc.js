// Operations Cost Plan 2027 – pure calculation engine (see CALCULATIONS.md).
// No DOM or platform calls: unit-tested in Node and inlined into the page.

export const YEAR = 2027;
const M = 12;
const months = Array.from({ length: M }, (_, i) => i);

export const BUCKET = { OPS: 'CTS - Operations', CARE: 'CTS - Customer care', OUT: 'Outside CTS' };
export const FV = { VAR: 'Variable', FIX: 'Fixed' };

const DEPARTMENT_BUCKET = {
  'Operations & Service': BUCKET.OPS,
  'Billing & Invoicing': BUCKET.OPS,
  'Switching & Metering': BUCKET.OPS,
  'Customer Service': BUCKET.CARE,
  'Pricing & Risk Management': BUCKET.OUT,
};

export const BLOCKS = [
  { id: 'payments', label: 'Payments & collections' },
  { id: 'comms', label: 'Customer communications' },
  { id: 'service', label: 'Customer service' },
  { id: 'csPlatform', label: 'CS platform' },
  { id: 'platforms', label: 'Platforms & market services' },
  { id: 'personnel', label: 'Personnel' },
];

const sum = (a) => a.reduce((s, x) => s + x, 0);
const series = (f) => months.map(f);
const line = (id, block, label, bucket, fv, monthly, totalMode = 'sum') => ({
  id, block, label, bucket, fv, monthly,
  total: totalMode === 'last' ? monthly[M - 1] : sum(monthly),
});

export function scalarMap(inputs) {
  const s = {};
  for (const { key, value } of inputs.scalars) s[key] = Number(value) || 0;
  return s;
}

export function deriveInputs(inputs) {
  const s = scalarMap(inputs);
  const sepaRaw = s.sepaFixedFee + s.sepaVariableFeePct * s.averagePaymentAmount;
  const d = {
    paymentMixCard: 1 - s.paymentMixSepa,
    noHumanNoAiShare: 1 - s.aiCallShare - s.directHumanCallShare,
    sepaFeePerTx: s.sepaFeeCap > 0 ? Math.min(sepaRaw, s.sepaFeeCap) : sepaRaw,
    cardFeePerTx: s.cardFixedFee + s.cardVariableFeePct * s.averagePaymentAmount,
    newCustomersVsTarget: sum(inputs.monthly.newCustomers.map(Number)) - s.yearEndCustomerTarget,
  };
  const errors = [];
  if (d.noHumanNoAiShare < 0) errors.push('noHumanNoAiShare < 0: AI + direct human call share above 100%');
  return { s, d, errors };
}

// ---- Personnel (CALCULATIONS.md §7) ----
const DAY = 86400000;
const dayNo = (iso) => (iso ? Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY) : null);
const monthStart = (m) => Date.UTC(YEAR, m, 1) / DAY;
const monthEnd = (m) => Date.UTC(YEAR, m + 1, 0) / DAY;

export function roleMonthly(role) {
  const start = dayNo(role.start);
  const end = dayNo(role.end);
  const fte = Number(role.fte) || 0;
  const q = Number(role.quarterlyCostAt1Fte) || 0;
  const fee = Number(role.oneOffHiringFee) || 0;
  const fteM = series((m) => {
    if (start === null) return 0;
    const ms = monthStart(m), me = monthEnd(m);
    const days = Math.max(0, Math.min(me, end ?? me) - Math.max(ms, start) + 1);
    return (fte * days) / (me - ms + 1);
  });
  const costM = series((m) => {
    const hired = start !== null && start >= monthStart(m) && start <= monthEnd(m);
    return (q / 3) * fteM[m] + (hired ? fee : 0);
  });
  return {
    id: role.id,
    department: role.department,
    fte: { monthly: fteM, total: sum(fteM) / M },
    cost: { monthly: costM, total: sum(costM) },
  };
}

// ---- Main ----
export function calculate(inputs, roles = [], departments) {
  const { s, d, errors } = deriveInputs(inputs);
  const nc = inputs.monthly.newCustomers.map((x) => Number(x) || 0);
  const lic = inputs.monthly.csLicences.map((x) => Number(x) || 0);

  // §2 Customer base
  const active = [];
  nc.forEach((n, m) => active.push((m ? active[m - 1] : Number(inputs.openingActiveCustomers) || 0) + n));
  const pods = active.map((a) => a * s.podsPerCustomer);

  // §3 Payments
  const pay = series((m) => active[m] * s.paymentsPerActiveCustomerPerMonth + nc[m] * s.startingPaymentsPerNewCustomer);
  const txSepa = pay.map((p) => p * s.paymentMixSepa);
  const txCard = pay.map((p) => p * d.paymentMixCard);
  const failSepa = txSepa.map((t) => t * s.failureRateSepa);
  const failCard = txCard.map((t) => t * s.failureRateCard);
  const r = s.retriesPerFailedPayment;

  // §4 Communications
  const paper = active.map((a) => a * s.invoicesPerActiveCustomerPerMonth * s.paperInvoiceShare);

  // §5 Customer service
  const calls = active.map((a) => a * s.inboundCallsPerActiveCustomerPerMonth);
  const ai = calls.map((c) => c * s.aiCallShare);
  const noHuman = calls.map((c) => c * d.noHumanNoAiShare);
  const humanMin = series((m) => (calls[m] * s.directHumanCallShare + ai[m] * s.aiEscalationToHumanShare) * s.avgHumanInboundCallMinutes);

  const { OPS, CARE, OUT } = BUCKET;
  const { VAR, FIX } = FV;
  const lines = [
    line('sepaCommissions', 'payments', 'SEPA DD commissions', OPS, VAR, txSepa.map((t) => t * d.sepaFeePerTx)),
    line('cardCommissions', 'payments', 'Card / wallet commissions', OPS, VAR, txCard.map((t) => t * d.cardFeePerTx)),
    line('retryFees', 'payments', 'Payment retries – transaction fees', OPS, VAR,
      series((m) => failSepa[m] * s.sepaFailedDebitFee + failSepa[m] * r * d.sepaFeePerTx + failCard[m] * r * d.cardFeePerTx)),
    line('stripeBilling', 'payments', 'Payment retries – Stripe Billing', OPS, VAR,
      series((m) => (failSepa[m] + failCard[m]) * r * s.averagePaymentAmount * s.stripeBillingPctOfRetriedVolume)),

    line('paperPrinting', 'comms', 'Paper invoices – printing & enveloping', OPS, VAR, paper.map((p) => p * s.printingEnvelopingPerPaperInvoice)),
    line('paperPostage', 'comms', 'Paper invoices – postage', OPS, VAR, paper.map((p) => p * s.postagePerPaperInvoice)),
    line('sms', 'comms', 'SMS', OPS, VAR, active.map((a) => a * s.smsPerActiveCustomerPerMonth * s.pricePerSms)),

    line('costOfContact', 'service', 'Cost of contact (AI + no human)', CARE, VAR, series((m) => (ai[m] + noHuman[m]) * s.costOfContact)),
    line('aiCalls', 'service', 'AI calls', CARE, VAR, ai.map((x) => x * s.costPerAiCall)),
    line('inboundHuman', 'service', 'Inbound calls – human', CARE, VAR, humanMin.map((x) => x * s.inboundCallPricePerMinute)),
    line('recordings', 'service', 'Recordings & transcripts', CARE, VAR, humanMin.map((x) => x * s.recordingsPricePerMinute)),
    line('outbound', 'service', 'Outbound calls', CARE, VAR,
      active.map((a) => a * s.outboundCallsPerActiveCustomerPerMonth * s.avgOutboundCallMinutes * s.outboundCallPricePerMinute)),
    line('disputes', 'service', 'Dispute resolution', CARE, VAR, active.map((a) => a * s.disputesPerActiveCustomerPerMonth * s.costPerDispute)),

    line('csLicences', 'csPlatform', 'CS platform licences', CARE, FIX, lic.map((n) => n * s.csLicencePricePerMonth)),
    line('phoneNumbers', 'csPlatform', 'Phone numbers', CARE, FIX, series(() => s.numberOfPhoneNumbers * s.phoneNumberFeePerMonth)),

    line('haulogyPod', 'platforms', 'Haulogy – POD fees', OPS, VAR, pods.map((p) => p * s.haulogyFeePerPodPerMonth)),
    line('haulogyFixed', 'platforms', 'Haulogy – fixed monthly fee', OPS, FIX, series(() => s.haulogyFixedFeePerMonth)),
    line('pricingConnector', 'platforms', 'Pricing connector platform', OUT, FIX, series(() => s.pricingConnectorLicencePerYear / 12)),
    line('equifax', 'platforms', 'Equifax – customer checks', OPS, VAR, nc.map((n) => n * s.equifaxCheckPerNewCustomer)),
  ];

  // §7 Personnel
  const roleResults = roles.map(roleMonthly);
  const depts = departments ?? [...new Set(roles.map((x) => x.department))].sort();
  for (const dep of depts) {
    const mine = roleResults.filter((x) => x.department === dep);
    lines.push(line(`personnel:${dep}`, 'personnel', dep, DEPARTMENT_BUCKET[dep] ?? OUT, FIX,
      series((m) => sum(mine.map((x) => x.cost.monthly[m])))));
  }
  const fteMonthly = series((m) => sum(roleResults.map((x) => x.fte.monthly[m])));

  // §9 Aggregates
  const agg = (pred) => {
    const monthly = series((m) => sum(lines.filter(pred).map((l) => l.monthly[m])));
    return { monthly, total: sum(monthly) };
  };
  const subtotals = Object.fromEntries(BLOCKS.map((b) => [b.id, agg((l) => l.block === b.id)]));
  const isCts = (l) => l.bucket === OPS || l.bucket === CARE;
  const aggregates = {
    subtotals,
    total: agg(() => true),
    variable: agg((l) => l.fv === VAR),
    fixed: agg((l) => l.fv === FIX),
    ctsOps: agg((l) => l.bucket === OPS),
    ctsCare: agg((l) => l.bucket === CARE),
    cts: agg(isCts),
    ctsVariable: agg((l) => isCts(l) && l.fv === VAR),
    outside: agg((l) => l.bucket === OUT),
  };

  // §10 Unit economics
  const avgPods = sum(pods) / M;
  const perPod = (x) => ({
    monthly: series((m) => (pods[m] ? (x.monthly[m] * 12) / pods[m] : 0)),
    total: avgPods ? x.total / avgPods : 0,
  });
  const unitEconomics = {
    ctsAverage: perPod(aggregates.cts),
    ctsOps: perPod(aggregates.ctsOps),
    ctsCare: perPod(aggregates.ctsCare),
    ctsMarginal: perPod(aggregates.ctsVariable),
  };

  const keyFigures = {
    newCustomers: { monthly: nc, total: sum(nc) },
    activeCustomers: { monthly: active, total: active[M - 1] },
    pods: { monthly: pods, total: sum(pods) / M }, // Summary r64 total = average (Calculations sheet shows December)
    payments: { monthly: pay, total: sum(pay) },
    fte: { monthly: fteMonthly, total: sum(fteMonthly) / M },
  };

  return { derived: d, errors, lines, aggregates, unitEconomics, keyFigures, personnel: { roles: roleResults } };
}

// ---- Summary row model (Excel Summary sheet; single source for the table and the export) ----
export const SUMMARY_DEPARTMENTS = ['Operations & Service', 'Billing & Invoicing', 'Customer Service', 'Pricing & Risk Management', 'Switching & Metering'];

const LINE_ROWS = [
  ['r06', 'sepaCommissions'], ['r07', 'cardCommissions'], ['r08', 'retryFees'], ['r09', 'stripeBilling'], ['r10', 'payments'],
  ['r13', 'paperPrinting'], ['r14', 'paperPostage'], ['r15', 'sms'], ['r16', 'comms'],
  ['r19', 'costOfContact'], ['r20', 'aiCalls'], ['r21', 'inboundHuman'], ['r22', 'recordings'], ['r23', 'outbound'], ['r24', 'disputes'], ['r25', 'service'],
  ['r28', 'csLicences'], ['r29', 'phoneNumbers'], ['r30', 'csPlatform'],
  ['r33', 'haulogyPod'], ['r34', 'haulogyFixed'], ['r35', 'pricingConnector'], ['r36', 'equifax'], ['r37', 'platforms'],
];
const SUBTOTAL_ROWS = new Set(['r10', 'r16', 'r25', 'r30', 'r37']);

export function summaryRows(result) {
  const { lines, aggregates: a, unitEconomics: u, keyFigures: k } = result;
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  const zero = Array(M).fill(0);
  const row = (r, kind, label, x, format = 'eur', extra = {}) => ({ row: r, kind, label, monthly: x.monthly, total: x.total, format, ...extra });
  const out = [];
  for (const [r, id] of LINE_ROWS) {
    if (SUBTOTAL_ROWS.has(r)) out.push(row(r, 'subtotal', `Subtotal ${BLOCKS.find((b) => b.id === id).label}`, a.subtotals[id]));
    else { const l = byId[id]; out.push(row(r, 'line', l.label, l, 'eur', { bucket: l.bucket, fv: l.fv })); }
  }
  // Departments: fixed Excel order r40-r44 (zero row if no roles), any other department appended after
  const personnel = lines.filter((l) => l.block === 'personnel');
  const extras = personnel.filter((l) => !SUMMARY_DEPARTMENTS.includes(l.label));
  [...SUMMARY_DEPARTMENTS, ...extras.map((l) => l.label)].forEach((dep, i) => {
    const l = personnel.find((x) => x.label === dep) ?? { monthly: zero, total: 0, bucket: DEPARTMENT_BUCKET[dep] ?? BUCKET.OUT, fv: FV.FIX };
    out.push(row(i < 5 ? `r${40 + i}` : `dept:${dep}`, 'line', dep, l, 'eur', { bucket: l.bucket, fv: l.fv }));
  });
  out.push(row('r45', 'subtotal', 'Subtotal Personnel', a.subtotals.personnel));
  out.push(row('r47', 'total', 'TOTAL OPERATIONS COST', a.total));
  out.push(row('r50', 'aggregate', 'Total variable cost', a.variable));
  out.push(row('r51', 'aggregate', 'Total fixed cost', a.fixed));
  out.push(row('r55', 'aggregate', 'CTS - Operations', a.ctsOps));
  out.push(row('r56', 'aggregate', 'CTS - Customer care', a.ctsCare));
  out.push(row('r57', 'aggregate', 'Total cost to serve (CTS)', a.cts));
  out.push(row('r58', 'aggregate', 'of which variable CTS', a.ctsVariable));
  out.push(row('r59', 'aggregate', 'Outside CTS (Pricing & Risk Management, pricing connector)', a.outside));
  out.push(row('r63', 'keyFigure', 'New customers', k.newCustomers, 'count'));
  out.push(row('r64', 'keyFigure', 'Active PODs (month) / average active PODs (total)', k.pods, 'count'));
  out.push(row('r65', 'keyFigure', 'Total payments', k.payments, 'count'));
  out.push(row('r66', 'keyFigure', 'Personnel FTE (total = average)', k.fte, 'fte'));
  out.push(row('r69', 'unitEconomics', 'CTS per POD per year - average', u.ctsAverage, 'eurPerPod'));
  out.push(row('r70', 'unitEconomics', 'of which Operations', u.ctsOps, 'eurPerPod'));
  out.push(row('r71', 'unitEconomics', 'of which Customer care', u.ctsCare, 'eurPerPod'));
  out.push(row('r72', 'unitEconomics', 'CTS per POD per year - marginal (variable only)', u.ctsMarginal, 'eurPerPod'));
  return out;
}
