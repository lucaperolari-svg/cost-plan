// Summary tab: headline tiles, monthly cost chart (Chart.js when loaded) and the Excel Summary table.
// renderSummary(container, result) is a pure render from a calculate() result: safe to call on every
// state change. It keeps one chart per container (updated in place) and rebuilds tiles and table.
import { summaryRows, BLOCKS } from '../calc.js';
import { h, fmt } from './dom.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// MET chart series, in the agreed order
export const SERIES = { fixed: '#005870', variable: '#F4C400', pods: '#46C3B2' };

const decimals = (n, d) => (typeof n === 'number' && Number.isFinite(n)
  ? new Intl.NumberFormat('en-IE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n) : '–');
const CELL = { eur: fmt.int, count: fmt.int, fte: fmt.fte, eurPerPod: (n) => decimals(n, 2) };
const BUCKET_SHORT = { 'CTS - Operations': 'CTS Ops', 'CTS - Customer care': 'CTS Care', 'Outside CTS': 'Outside CTS' };
// presentational section headers before these rows (block headers are placed by position)
const SECTION_BEFORE = { r50: 'Fixed / variable split', r55: 'Cost by bucket', r63: 'Key figures', r69: 'Unit economics' };

const views = new WeakMap(); // container -> {tiles, chartBox, table, chart}

export function renderSummary(container, result) {
  let v = views.get(container);
  if (!v || !container.contains(v.root)) {
    v?.chart?.destroy();
    v = build(container);
    views.set(container, v);
  }
  const rows = summaryRows(result);
  v.tiles.replaceChildren(...tiles(result));
  v.tableBody.replaceChildren(...tableRows(rows));
  renderChart(v, result);
  return v;
}

export function destroySummary(container) {
  const v = views.get(container);
  v?.chart?.destroy();
  views.delete(container);
}

function build(container) {
  const tilesEl = h('div', { class: 'tiles' });
  const chartBox = h('div', { class: 'chart-box' });
  const tableBody = h('tbody');
  const head = h('thead', {}, h('tr', {},
    h('th', { scope: 'col', class: 'col-label' }, 'Line'),
    h('th', { scope: 'col', class: 'col-tags' }, 'Bucket · F/V'),
    MONTHS.map((m) => h('th', { scope: 'col', class: 'num' }, m)),
    h('th', { scope: 'col', class: 'num col-total' }, 'Total 2027')));
  const root = h('div', { class: 'summary' },
    tilesEl,
    h('section', { class: 'card', 'aria-labelledby': 'sum-chart-title' },
      h('h2', { id: 'sum-chart-title', class: 'card-title' }, 'Monthly operations cost, 2027'),
      h('p', { class: 'card-note' }, 'Fixed and variable cost per month (€, stacked bars), with active PODs as a line on the right-hand axis.'),
      chartBox),
    h('section', { class: 'card', 'aria-labelledby': 'sum-table-title' },
      h('h2', { id: 'sum-table-title', class: 'card-title' }, 'Monthly summary'),
      h('p', { class: 'card-note' }, 'Costs in €. Key figures in units; FTE to 2 decimals; unit economics in € per POD per year.'),
      h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'sum-table-title' },
        h('table', { class: 'sum-table' }, head, tableBody))));
  container.replaceChildren(root);
  return { root, tiles: tilesEl, chartBox, tableBody, chart: null, canvas: null };
}

function tile(label, value, context) {
  return h('div', { class: 'tile' },
    h('p', { class: 'tile-label' }, label),
    h('p', { class: 'tile-value' }, value),
    context ? h('p', { class: 'tile-context' }, context) : null);
}

function tiles(result) {
  const { aggregates: a, unitEconomics: u } = result;
  const total = a.total.total, fixed = a.fixed.total, variable = a.variable.total;
  const share = total ? fixed / total : 0;
  return [
    tile('Total operations cost 2027', fmt.eur(total), 'Jan–Dec 2027, all lines'),
    tile('December CTS per POD per year — average', fmt.eur(u.ctsAverage.monthly[11], 2), 'Cost to serve, annualised, per active POD'),
    tile('December CTS per POD per year — marginal (variable only)', fmt.eur(u.ctsMarginal.monthly[11], 2), 'Variable cost to serve only'),
    tile('Fixed cost share of 2027', fmt.pct(share, 1), `${fmt.eur(fixed)} fixed · ${fmt.eur(variable)} variable`),
  ];
}

function sectionRow(label) {
  return h('tr', { class: 'sum-section' },
    h('th', { scope: 'rowgroup', class: 'col-label' }, label),
    h('td', { colspan: String(MONTHS.length + 2) }));
}

function tags(r) {
  if (r.kind !== 'line') return null;
  const fv = r.fv === 'Variable' ? 'variable' : 'fixed';
  return [
    h('span', { class: 'tag tag-bucket', title: r.bucket, dataset: { value: r.bucket } }, BUCKET_SHORT[r.bucket] ?? r.bucket),
    h('span', { class: `tag tag-fv tag-${fv}`, title: r.fv, dataset: { value: r.fv } }, r.fv),
  ];
}

function tableRows(rows) {
  const out = [];
  let block = 0, startBlock = true;
  for (const r of rows) {
    if (SECTION_BEFORE[r.row]) out.push(sectionRow(SECTION_BEFORE[r.row]));
    else if (startBlock && block < BLOCKS.length && r.kind === 'line') { out.push(sectionRow(BLOCKS[block].label)); startBlock = false; }
    if (r.kind === 'subtotal') { block++; startBlock = true; }
    const f = CELL[r.format] ?? fmt.int;
    const cell = (n, cls = 'num') => h('td', { class: n === 0 ? `${cls} zero` : cls }, f(n));
    out.push(h('tr', { class: `sum-${r.kind}`, dataset: { row: r.row, kind: r.kind } },
      h('th', { scope: 'row', class: 'col-label' }, r.label),
      h('td', { class: 'col-tags' }, tags(r)),
      r.monthly.map((n) => cell(n)),
      cell(r.total, 'num col-total')));
  }
  return out;
}

// --- chart
function themeColors(el) {
  const cs = getComputedStyle(el);
  const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  return { ink: v('--ink', '#1b2a30'), muted: v('--muted', '#63656a'), line: v('--line', '#d6e0e3'), surface: v('--surface', '#ffffff'), font: v('--font', 'sans-serif') };
}
const compactEur = (n) => `€${new Intl.NumberFormat('en-IE', { notation: 'compact', maximumFractionDigits: 0 }).format(n)}`;

function chartConfig(result, c) {
  const fixed = [...result.aggregates.fixed.monthly];
  const variable = [...result.aggregates.variable.monthly];
  const pods = [...result.keyFigures.pods.monthly];
  const topRadius = { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 };
  return {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [
        { type: 'bar', label: 'Fixed', data: fixed, yAxisID: 'y', stack: 'cost', order: 2,
          backgroundColor: SERIES.fixed, maxBarThickness: 24, borderWidth: 0,
          borderRadius: (ctx) => (variable[ctx.dataIndex] > 0 ? 0 : topRadius), borderSkipped: 'start' },
        { type: 'bar', label: 'Variable', data: variable, yAxisID: 'y', stack: 'cost', order: 2,
          backgroundColor: SERIES.variable, maxBarThickness: 24,
          borderColor: c.surface, borderWidth: { top: 0, left: 0, right: 0, bottom: 2 }, borderSkipped: false, borderRadius: topRadius },
        { type: 'line', label: 'Active PODs', data: pods, yAxisID: 'y2', order: 1,
          borderColor: SERIES.pods, backgroundColor: SERIES.pods, borderWidth: 2, borderJoinStyle: 'round', borderCapStyle: 'round',
          pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: c.surface, tension: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      font: { family: c.font },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { sort: (a, b) => a.datasetIndex - b.datasetIndex, color: c.ink, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10, font: { family: c.font, size: 12 } } },
        tooltip: {
          backgroundColor: c.surface, titleColor: c.ink, bodyColor: c.ink, footerColor: c.ink, borderColor: c.line, borderWidth: 1,
          padding: 10, usePointStyle: true, titleFont: { family: c.font }, bodyFont: { family: c.font }, footerFont: { family: c.font },
          callbacks: {
            label: (ctx) => (ctx.dataset.yAxisID === 'y2' ? ` ${ctx.dataset.label}: ${fmt.int(ctx.parsed.y)}` : ` ${ctx.dataset.label}: ${fmt.eur(ctx.parsed.y)}`),
            footer: (items) => { const i = items[0]?.dataIndex; return i === undefined ? '' : `Total: ${fmt.eur(fixed[i] + variable[i])}`; },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: c.line }, ticks: { color: c.muted, font: { family: c.font, size: 11 }, maxRotation: 0, autoSkipPadding: 6 } },
        y: { stacked: true, beginAtZero: true, position: 'left', grid: { color: c.line, lineWidth: 1 }, border: { display: false },
          title: { display: true, text: 'Cost per month (€)', color: c.muted, font: { family: c.font, size: 11 } },
          ticks: { color: c.muted, font: { family: c.font, size: 11 }, callback: (n) => compactEur(n), maxTicksLimit: 6 } },
        y2: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, border: { display: false },
          title: { display: true, text: 'Active PODs', color: c.muted, font: { family: c.font, size: 11 } },
          ticks: { color: c.muted, font: { family: c.font, size: 11 }, precision: 0, maxTicksLimit: 6 } },
      },
    },
  };
}

function renderChart(v, result) {
  const Chart = typeof window !== 'undefined' ? window.Chart : undefined;
  if (typeof Chart !== 'function') {
    if (!v.chartBox.firstChild) v.chartBox.append(h('p', { class: 'card-note chart-missing' }, 'The chart is unavailable (charting library not loaded). The table below has every value.'));
    return;
  }
  const config = chartConfig(result, themeColors(v.chartBox));
  if (v.chart && v.canvas && v.chartBox.contains(v.canvas)) {
    v.chart.data.datasets.forEach((d, i) => { d.data = config.data.datasets[i].data; Object.assign(d, { borderRadius: config.data.datasets[i].borderRadius }); });
    v.chart.update('none');
    return;
  }
  v.chart?.destroy();
  v.canvas = h('canvas', { role: 'img', 'aria-label': 'Monthly operations cost 2027: fixed and variable stacked bars, active PODs line. Values are in the table below.' });
  v.chartBox.replaceChildren(h('div', { class: 'chart-wrap' }, v.canvas));
  try { v.chart = new Chart(v.canvas, config); } catch (e) { console.error(e); v.chart = null; }
}
