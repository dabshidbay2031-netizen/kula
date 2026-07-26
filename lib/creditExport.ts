/**
 * Credit-ledger export.
 *
 * Shops keep credit for their regulars ("deyn"), and that ledger is the most
 * valuable thing in the app for them — losing it means losing money they are
 * owed. This builds a downloadable copy they can keep off-platform: their own
 * backup, on their own device, whenever they want it.
 *
 * Two shapes:
 *   summary — one row per customer: what they owe right now.
 *   detail  — one row per invoice: the full ledger, so the file alone can
 *             reconstruct the debt if everything else is lost.
 *
 * Everything here is pure so it can be tested without a database — money and
 * CSV escaping are exactly the places a silent mistake costs someone real
 * money.
 */

export interface ExportInvoice {
  id:           string;
  customerId:   string;
  customerName: string;
  total:        number;
  paidTotal:    number;
  status:       string;
  notes?:       string | null;
  createdAt:    string;
}

export interface ExportCustomer {
  id:    string;
  name:  string;
  phone?: string | null;
}

/** Round like money, not like floating point: 0.1 + 0.2 must not be 0.30000000000000004. */
export function money2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** What's still owed on one invoice. Never negative — an overpayment is not a debt. */
export function outstanding(inv: Pick<ExportInvoice, 'total' | 'paidTotal'>): number {
  return Math.max(money2(inv.total) - money2(inv.paidTotal), 0);
}

/**
 * Escape one CSV field.
 *
 * A customer called `Xasan "Cadde", Jr` will corrupt every column after it if
 * this is wrong, and a leading =/+/-/@ turns the cell into a formula when the
 * shop opens it in Excel. Both are handled here.
 */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;          // neutralise formula injection
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  // BOM so Excel reads UTF-8 — without it Somali names render as mojibake.
  // CRLF because that is what Excel expects from a .csv.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export interface CustomerCredit {
  customerId:   string;
  customerName: string;
  phone:        string;
  invoices:     number;
  billed:       number;
  paid:         number;
  outstanding:  number;
  oldestUnpaid: string | null;
  lastActivity: string | null;
}

/** Roll invoices up per customer, newest activity and oldest debt included. */
export function summarise(
  invoices: ExportInvoice[],
  customers: ExportCustomer[] = [],
): CustomerCredit[] {
  const phoneById = new Map(customers.map(c => [String(c.id), c.phone ?? '']));
  const byCustomer = new Map<string, CustomerCredit>();

  for (const inv of invoices) {
    const key = String(inv.customerId);
    const row = byCustomer.get(key) ?? {
      customerId:   key,
      customerName: inv.customerName || '(unnamed)',
      phone:        phoneById.get(key) ?? '',
      invoices:     0,
      billed:       0,
      paid:         0,
      outstanding:  0,
      oldestUnpaid: null,
      lastActivity: null,
    };

    const owed = outstanding(inv);
    row.invoices    += 1;
    row.billed       = money2(row.billed + inv.total);
    row.paid         = money2(row.paid + inv.paidTotal);
    row.outstanding  = money2(row.outstanding + owed);

    if (owed > 0 && (!row.oldestUnpaid || inv.createdAt < row.oldestUnpaid)) {
      row.oldestUnpaid = inv.createdAt;
    }
    if (!row.lastActivity || inv.createdAt > row.lastActivity) {
      row.lastActivity = inv.createdAt;
    }
    byCustomer.set(key, row);
  }

  // Biggest debt first — that's the list a shop actually chases.
  return Array.from(byCustomer.values()).sort((a, b) => b.outstanding - a.outstanding);
}

const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export function summaryCsv(rows: CustomerCredit[]): string {
  return toCsv(
    ['Customer', 'Phone', 'Invoices', 'Total billed', 'Total paid', 'Outstanding', 'Oldest unpaid', 'Last activity'],
    rows.map(r => [
      r.customerName, r.phone, r.invoices,
      r.billed.toFixed(2), r.paid.toFixed(2), r.outstanding.toFixed(2),
      fmtDate(r.oldestUnpaid), fmtDate(r.lastActivity),
    ]),
  );
}

export function detailCsv(invoices: ExportInvoice[], customers: ExportCustomer[] = []): string {
  const phoneById = new Map(customers.map(c => [String(c.id), c.phone ?? '']));
  const sorted = [...invoices].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return toCsv(
    ['Invoice', 'Date', 'Customer', 'Phone', 'Total', 'Paid', 'Outstanding', 'Status', 'Notes'],
    sorted.map(i => [
      i.id, fmtDate(i.createdAt), i.customerName, phoneById.get(String(i.customerId)) ?? '',
      money2(i.total).toFixed(2), money2(i.paidTotal).toFixed(2), outstanding(i).toFixed(2),
      i.status, i.notes ?? '',
    ]),
  );
}

/** Totals for the footer line / on-screen confirmation. */
export function totals(rows: CustomerCredit[]) {
  return rows.reduce(
    (t, r) => ({
      customers:   t.customers + 1,
      invoices:    t.invoices + r.invoices,
      billed:      money2(t.billed + r.billed),
      paid:        money2(t.paid + r.paid),
      outstanding: money2(t.outstanding + r.outstanding),
    }),
    { customers: 0, invoices: 0, billed: 0, paid: 0, outstanding: 0 },
  );
}

/** e.g. "credits-daily-city-care-pharmacy-2026-07-27.csv" */
export function exportFileName(storeName: string, periodLabel: string, at: Date): string {
  const slug = String(storeName || 'store').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `credits-${periodLabel.toLowerCase()}-${slug || 'store'}-${at.toISOString().slice(0, 10)}.csv`;
}
