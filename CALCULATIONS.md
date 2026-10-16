# Calculation logic (source of truth = `reference/Operations_Cost_Plan_2027_v5.xlsx`)

Notation: `m` = month 1..12 of 2027. Scalar inputs by key from `data/inputs.json` (`in.<key>`). All amounts EUR. Shares are fractions (0.2 = 20%). Every monthly line also has a **Total 2027** = sum of months, unless stated.

## 1. Derived inputs
- `paymentMixCard = 1 − paymentMixSepa`
- `noHumanNoAiShare = 1 − aiCallShare − directHumanCallShare` (error if < 0)
- `sepaFeePerTx = sepaFeeCap > 0 ? MIN(sepaFixedFee + sepaVariableFeePct × averagePaymentAmount, sepaFeeCap) : sepaFixedFee + sepaVariableFeePct × averagePaymentAmount`
- `cardFeePerTx = cardFixedFee + cardVariableFeePct × averagePaymentAmount`
- Check: `Σ newCustomers − yearEndCustomerTarget` (0 = phasing matches target)

## 2. Customer base
- `new[m] = monthly.newCustomers[m]`
- `active[m] = active[m−1] + new[m]`, `active[0] = openingActiveCustomers (0)` — Total column = December value
- `pods[m] = active[m] × podsPerCustomer` — Total column = December value

## 3. Payments
- `payMonthly = active × paymentsPerActiveCustomerPerMonth`
- `payStart = new × startingPaymentsPerNewCustomer`
- `pay = payMonthly + payStart`
- `txSepa = pay × paymentMixSepa`; `txCard = pay × paymentMixCard`
- **SEPA DD commissions** = `txSepa × sepaFeePerTx`
- **Card / wallet commissions** = `txCard × cardFeePerTx`

### Retries
- `failSepa = txSepa × failureRateSepa`; `failCard = txCard × failureRateCard`
- `sepaFailureFees = failSepa × sepaFailedDebitFee`
- `sepaRetryFees = failSepa × retriesPerFailedPayment × sepaFeePerTx`
- `cardRetryFees = failCard × retriesPerFailedPayment × cardFeePerTx`
- **Payment retries – transaction fees** = `sepaFailureFees + sepaRetryFees + cardRetryFees`
- `retriedVolume = (failSepa + failCard) × retriesPerFailedPayment × averagePaymentAmount`
- **Payment retries – Stripe Billing** = `retriedVolume × stripeBillingPctOfRetriedVolume` (0.7% applies to retried volume only, not to first attempts)

## 4. Customer communications
- `invoices = active × invoicesPerActiveCustomerPerMonth`; `paper = invoices × paperInvoiceShare`
- **Paper invoices – printing & enveloping** = `paper × printingEnvelopingPerPaperInvoice`
- **Paper invoices – postage** = `paper × postagePerPaperInvoice`
- **SMS** = `active × smsPerActiveCustomerPerMonth × pricePerSms`

## 5. Customer service (three call paths)
- `calls = active × inboundCallsPerActiveCustomerPerMonth`
- Path 1 `ai = calls × aiCallShare`; Path 2 `humanDirect = calls × directHumanCallShare`; Path 3 `noHuman = calls × noHumanNoAiShare`
- `escalated = ai × aiEscalationToHumanShare`; `humanCalls = humanDirect + escalated`
- `humanMinutes = humanCalls × avgHumanInboundCallMinutes`
- **Cost of contact (AI + no human)** = `(ai + noHuman) × costOfContact` (0.89)
- **AI calls** = `ai × costPerAiCall` (1.99, on top of cost of contact)
- **Inbound calls – human** = `humanMinutes × inboundCallPricePerMinute` (no cost of contact on human calls)
- **Recordings & transcripts** = `humanMinutes × recordingsPricePerMinute`
- **Outbound calls** = `active × outboundCallsPerActiveCustomerPerMonth × avgOutboundCallMinutes × outboundCallPricePerMinute`
- **Dispute resolution** = `active × disputesPerActiveCustomerPerMonth × costPerDispute`
- An escalated AI call therefore pays 0.89 + 1.99 + its human minutes.

## 6. CS platform and platforms
- **CS platform licences** = `monthly.csLicences[m] × csLicencePricePerMonth`
- **Phone numbers** = `numberOfPhoneNumbers × phoneNumberFeePerMonth` (every month)
- **Haulogy – POD fees** = `pods × haulogyFeePerPodPerMonth`
- **Haulogy – fixed monthly fee** = `haulogyFixedFeePerMonth` (every month, from January)
- **Equifax – customer checks** = `new × equifaxCheckPerNewCustomer` (one check at sign-up)
- **Pricing connector platform** = `pricingConnectorLicencePerYear / 12` (every month)

## 7. Personnel (per role)
Month bounds: `ms` = first day, `me` = last day of month m.
- `monthlyFte = start empty ? 0 : fte × MAX(0, MIN(me, end ?? me) − MAX(ms, start) + 1) / (me − ms + 1)` (calendar days, dates inclusive)
- `monthlyCost = quarterlyCostAt1Fte / 3 × monthlyFte + (start within [ms, me] ? oneOffHiringFee : 0)`
- Hiring fee is booked only if the start date falls inside 2027 (roles starting in 2026 do not book it in 2027).
- Department line on Summary = sum of its roles' `monthlyCost`; FTE key figure = sum of all `monthlyFte` (Total column = average of 12 months).

## 8. Tags (bucket / fixed-variable)

| Summary line | Bucket | F/V |
|---|---|---|
| SEPA DD commissions, Card commissions, Retry fees, Stripe Billing | CTS - Operations | Variable |
| Paper printing, Paper postage, SMS | CTS - Operations | Variable |
| Cost of contact, AI calls, Inbound human, Recordings, Outbound, Disputes | CTS - Customer care | Variable |
| CS platform licences, Phone numbers | CTS - Customer care | Fixed |
| Haulogy POD fees, Equifax checks | CTS - Operations | Variable |
| Haulogy fixed monthly fee | CTS - Operations | Fixed |
| Pricing connector platform | Outside CTS | Fixed |
| Personnel: Operations & Service, Billing & Invoicing, Switching & Metering | CTS - Operations | Fixed |
| Personnel: Customer Service | CTS - Customer care | Fixed |
| Personnel: Pricing & Risk Management | Outside CTS | Fixed |

## 9. Summary aggregates
- Block subtotals = sum of block lines; **TOTAL** = sum of 6 subtotals.
- `variable = Σ lines tagged Variable`; `fixed = Σ Fixed`; check `TOTAL − variable − fixed = 0`.
- `ctsOps`, `ctsCare` = Σ by bucket; `cts = ctsOps + ctsCare`; `ctsVariable = Σ lines with bucket CTS* and Variable`; `outside = Σ Outside CTS`; check `TOTAL − cts − outside = 0`.

## 10. Unit economics (EUR per POD per year)
- Monthly column (run-rate): `x[m] × 12 / pods[m]` (0 if pods = 0)
- Total column (full year): `Σ x / average(pods[1..12])` (0 if average = 0)
- Lines: CTS average (x = cts), of which Operations (ctsOps), of which Customer care (ctsCare), CTS marginal (x = ctsVariable).
- December column is the steady-state view (PODs start in July in the v5 data).
