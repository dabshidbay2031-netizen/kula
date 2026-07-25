/**
 * Dashboard PDF export.
 *
 * The app ships no PDF library, and the existing invoice/receipt printing
 * already uses the browser's own print pipeline — so a "download" here means
 * opening a clean, print-styled report and letting the browser's
 * "Save as PDF" produce the file. Same pattern, no new dependency, works
 * offline.
 *
 * The report always covers exactly the period selected on the dashboard: the
 * day for Daily, the week for Weekly, and so on.
 */

export interface ReportRow {
  label:   string;
  orders:  number;
  units:   number;
  revenue: number;
  cost:    number;
  profit:  number;
}

export interface ReportInput {
  storeName:    string;
  /** "Daily" | "Weekly" | "Monthly" | "Yearly" */
  periodLabel:  string;
  /** Human range covered, e.g. "11 Jul 2026 – 24 Jul 2026". */
  rangeLabel:   string;
  /** "All sales" | "Online" | "In-store" */
  channelLabel: string;
  generatedAt:  Date;
  totals: {
    revenue: number; cost: number; profit: number;
    orders: number;  units: number; avgOrder: number; marginPct: number;
  };
  rows:         ReportRow[];
  topProducts:  { name: string; units: number; revenue: number }[];
  categories:   { name: string; revenue: number }[];
  payments?:    { online: number; cash: number; paidOut: number; pending: number; balance: number };
}

/** Escape text before it goes into the report markup — a store name or product
 *  title containing `<` or `&` would otherwise corrupt the document. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const money = (n: number) =>
  `$${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A filename the browser suggests when saving: "the-business-monthly-2026-07-24.pdf" */
export function reportFileName(storeName: string, periodLabel: string, at: Date): string {
  const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'store';
  const day  = at.toISOString().slice(0, 10);
  return `${slug}-${periodLabel.toLowerCase()}-${day}`;
}

export function buildDashboardReportHtml(input: ReportInput): string {
  const { storeName, periodLabel, rangeLabel, channelLabel, generatedAt, totals, rows, topProducts, categories, payments } = input;

  const bodyRows = rows.map(r => `
    <tr>
      <td>${esc(r.label)}</td>
      <td class="num">${r.orders}</td>
      <td class="num">${r.units}</td>
      <td class="num">${money(r.revenue)}</td>
      <td class="num">${money(r.cost)}</td>
      <td class="num ${r.profit < 0 ? 'neg' : 'pos'}">${money(r.profit)}</td>
    </tr>`).join('');

  const topRows = topProducts.length
    ? topProducts.map((p, i) => `
      <tr>
        <td class="rank">${i + 1}</td>
        <td>${esc(p.name)}</td>
        <td class="num">${p.units}</td>
        <td class="num">${money(p.revenue)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="empty">No sales in this period.</td></tr>`;

  const catRows = categories.length
    ? categories.map(c => `
      <tr>
        <td>${esc(c.name)}</td>
        <td class="num">${money(c.revenue)}</td>
        <td class="num">${totals.revenue > 0 ? Math.round((c.revenue / totals.revenue) * 100) : 0}%</td>
      </tr>`).join('')
    : `<tr><td colspan="3" class="empty">No category sales in this period.</td></tr>`;

  const paymentsBlock = payments ? `
    <h2>Payments</h2>
    <table class="kv">
      <tbody>
        <tr><td>Online received (Sifalo / Waafi)</td><td class="num">${money(payments.online)}</td></tr>
        <tr><td>Cash received (POS &amp; on delivery)</td><td class="num">${money(payments.cash)}</td></tr>
        <tr><td>Paid out</td><td class="num">${money(payments.paidOut)}</td></tr>
        <tr><td>Awaiting approval</td><td class="num">${money(payments.pending)}</td></tr>
        <tr class="total"><td>Available to withdraw</td><td class="num">${money(payments.balance)}</td></tr>
      </tbody>
    </table>
    <p class="note">Wallet figures are lifetime-to-date from when your wallet started, not limited to the report period.</p>
  ` : '';

  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>${esc(storeName)} — ${esc(periodLabel)} report</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;padding:40px;max-width:860px;margin:0 auto;font-size:13px;line-height:1.5}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:18px;border-bottom:2.5px solid #4F46E5;margin-bottom:22px}
  h1{font-size:1.5rem;font-weight:800;color:#4F46E5;line-height:1.2}
  .sub{font-size:.82rem;color:#64748b;margin-top:6px}
  .meta{text-align:right;font-size:.78rem;color:#64748b;white-space:nowrap}
  .meta strong{display:block;font-size:.95rem;color:#0f172a;margin-bottom:3px}
  h2{font-size:.95rem;font-weight:800;margin:26px 0 10px;padding-bottom:5px;border-bottom:1px solid #e2e8f0}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:6px}
  .card{border:1px solid #e2e8f0;border-radius:10px;padding:11px 13px;background:#f8fafc}
  .card .lbl{font-size:.63rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#94a3b8}
  .card .val{font-size:1.15rem;font-weight:800;margin-top:3px}
  .card .hint{font-size:.68rem;color:#64748b;margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  th{font-size:.63rem;text-transform:uppercase;letter-spacing:.07em;color:#94a3b8;padding:8px 10px;border-bottom:1.5px solid #e2e8f0;text-align:left;font-weight:800}
  td{padding:7px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .rank{color:#94a3b8;font-weight:800;width:28px}
  .pos{color:#059669;font-weight:700}
  .neg{color:#dc2626;font-weight:700}
  .empty{color:#94a3b8;text-align:center;padding:14px}
  tfoot td{border-top:2px solid #0f172a;border-bottom:none;font-weight:800;padding-top:9px}
  .kv td:first-child{color:#475569}
  .kv .total td{border-top:2px solid #0f172a;font-weight:800}
  .note{font-size:.7rem;color:#94a3b8;margin-top:6px;font-style:italic}
  footer{margin-top:30px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:.7rem;color:#94a3b8;text-align:center}
  @media print{
    body{padding:16px;max-width:none}
    h2{break-after:avoid}
    table{break-inside:auto}
    tr{break-inside:avoid;break-after:auto}
    thead{display:table-header-group}
  }
</style></head><body>

<header>
  <div>
    <h1>${esc(storeName)}</h1>
    <div class="sub">${esc(periodLabel)} sales report &middot; ${esc(channelLabel)}</div>
  </div>
  <div class="meta">
    <strong>${esc(rangeLabel)}</strong>
    Generated ${esc(generatedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}
  </div>
</header>

<h2>Summary</h2>
<div class="cards">
  <div class="card"><div class="lbl">Revenue</div><div class="val">${money(totals.revenue)}</div><div class="hint">${totals.orders} order${totals.orders !== 1 ? 's' : ''}</div></div>
  <div class="card"><div class="lbl">Total costs</div><div class="val">${money(totals.cost)}</div><div class="hint">${totals.revenue > 0 ? Math.round((totals.cost / totals.revenue) * 100) : 0}% of revenue</div></div>
  <div class="card"><div class="lbl">Profit</div><div class="val ${totals.profit < 0 ? 'neg' : 'pos'}">${money(totals.profit)}</div><div class="hint">${totals.marginPct}% margin</div></div>
  <div class="card"><div class="lbl">Units sold</div><div class="val">${totals.units}</div><div class="hint">${money(totals.avgOrder)} avg order</div></div>
</div>

<h2>Breakdown</h2>
<table>
  <thead><tr>
    <th>Period</th><th class="num">Orders</th><th class="num">Units</th>
    <th class="num">Revenue</th><th class="num">Costs</th><th class="num">Profit</th>
  </tr></thead>
  <tbody>${bodyRows}</tbody>
  <tfoot><tr>
    <td>Total</td>
    <td class="num">${totals.orders}</td>
    <td class="num">${totals.units}</td>
    <td class="num">${money(totals.revenue)}</td>
    <td class="num">${money(totals.cost)}</td>
    <td class="num">${money(totals.profit)}</td>
  </tr></tfoot>
</table>

<h2>Top products</h2>
<table>
  <thead><tr><th></th><th>Product</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead>
  <tbody>${topRows}</tbody>
</table>

<h2>Revenue by category</h2>
<table>
  <thead><tr><th>Category</th><th class="num">Revenue</th><th class="num">Share</th></tr></thead>
  <tbody>${catRows}</tbody>
</table>

${paymentsBlock}

<footer>Hamar Mall &middot; ${esc(storeName)} &middot; ${esc(periodLabel)} report for ${esc(rangeLabel)}</footer>
</body></html>`;
}

/**
 * Open the report in a new window and trigger the browser's print/save dialog.
 * Returns false when a popup blocker stopped it, so the caller can tell the user.
 */
export function openReportForPrint(html: string, title: string): boolean {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return false;
  win.document.write(html);
  win.document.title = title;      // becomes the suggested "Save as PDF" filename
  win.document.close();
  // Let fonts/layout settle before the dialog opens, or the first page renders unstyled.
  setTimeout(() => { try { win.focus(); win.print(); } catch { /* user can print manually */ } }, 500);
  return true;
}
