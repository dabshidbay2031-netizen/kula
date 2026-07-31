/**
 * Dashboard export — CSV.
 *
 * The dashboard already exports a PDF (lib/dashboardReport.ts), which is for
 * *reading*. This is for *keeping*: a machine-readable copy of what a store
 * actually sold, so the numbers can be re-derived if the platform is ever lost.
 * That is why the raw rows ship alongside the summary — a totals-only file
 * cannot rebuild a business.
 *
 * Money and CSV escaping live in lib/creditExport.ts and are reused verbatim
 * rather than reimplemented: two different escapers is how one of them ends up
 * subtly wrong on the day it matters.
 *
 * Revenue rules come from lib/revenue.ts so an exported figure can never
 * disagree with the figure the shop sees on screen.
 */

import { csvCell, toCsv, money2, localDate, localTime } from '@/lib/creditExport';
import { isRevenueOrder, orderChannel } from '@/lib/revenue';

export interface ExportOrderItem {
  name?:  string | null;
  qty?:   number | null;
  price?: number | null;
  /** Unit cost, when the store recorded one — drives profit. */
  cost?:  number | null;
  category?: string | null;
}

export interface ExportOrder {
  id:             string;
  createdAt:      string;
  status:         string;
  total:          number;
  customerName?:  string | null;
  paymentMethod?: string | null;
  /** Presence of either marks the order as an in-store (POS) sale. */
  sessionId?:     string | null;
  cashierName?:   string | null;
  items?:         ExportOrderItem[];
}

const num = (v: unknown): number => (Number(v) || 0);

/** Units on an order — the count of things handed over, not the line count. */
export function orderUnits(o: ExportOrder): number {
  return (o.items ?? []).reduce((n, it) => n + num(it.qty), 0);
}

/**
 * Cost of goods on an order. Only lines that actually carry a cost contribute;
 * a missing cost is treated as unknown (0) rather than guessed from the price,
 * which would silently invent profit that was never made.
 */
export function orderCost(o: ExportOrder): number {
  return money2((o.items ?? []).reduce((c, it) => c + num(it.cost) * num(it.qty), 0));
}

export interface DashboardTotals {
  orders:    number;
  units:     number;
  revenue:   number;
  cost:      number;
  profit:    number;
  avgOrder:  number;
  marginPct: number;
  online:    number;
  inStore:   number;
  /** Orders excluded from revenue (deleted / cancelled / refunded). */
  excluded:  number;
}

/**
 * Roll a set of orders into the headline figures.
 *
 * Non-revenue orders (deleted/cancelled/refunded) are counted separately rather
 * than dropped, so the file shows that they existed without letting their money
 * inflate the takings.
 */
export function summariseOrders(orders: ExportOrder[]): DashboardTotals {
  let revenue = 0, cost = 0, units = 0, count = 0, online = 0, inStore = 0, excluded = 0;

  for (const o of orders) {
    if (!isRevenueOrder(o)) { excluded++; continue; }
    count++;
    revenue = money2(revenue + num(o.total));
    cost    = money2(cost + orderCost(o));
    units  += orderUnits(o);
    if (orderChannel(o) === 'pos') inStore = money2(inStore + num(o.total));
    else                           online  = money2(online  + num(o.total));
  }

  const profit = money2(revenue - cost);
  return {
    orders: count, units, revenue, cost, profit,
    avgOrder:  count ? money2(revenue / count) : 0,
    marginPct: revenue > 0 ? Math.round((profit / revenue) * 100) : 0,
    online, inStore, excluded,
  };
}

/** One row per ORDER — the transaction track. */
export function ordersCsv(orders: ExportOrder[]): string {
  const sorted = [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return toCsv(
    ['Date', 'Time', 'Order', 'Channel', 'Status', 'Counts as revenue', 'Customer',
     'Payment', 'Units', 'Revenue', 'Cost', 'Profit'],
    sorted.map(o => {
      const counts = isRevenueOrder(o);
      const cost   = orderCost(o);
      return [
        localDate(o.createdAt), localTime(o.createdAt), o.id,
        orderChannel(o) === 'pos' ? 'In-store' : 'Online',
        o.status, counts ? 'yes' : 'no',
        o.customerName ?? '', o.paymentMethod ?? '',
        orderUnits(o),
        counts ? money2(o.total).toFixed(2) : '0.00',
        counts ? cost.toFixed(2) : '0.00',
        counts ? money2(num(o.total) - cost).toFixed(2) : '0.00',
      ];
    }),
  );
}

/**
 * One row per LINE ITEM — literally "whatever they sold".
 *
 * This is the file that rebuilds a catalogue's sales history: the order-level
 * sheet says $40 changed hands, only this one says which four things moved.
 */
export function soldItemsCsv(orders: ExportOrder[]): string {
  const rows: (string | number)[][] = [];
  const sorted = [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  for (const o of sorted) {
    const counts = isRevenueOrder(o);
    for (const it of o.items ?? []) {
      const qty  = num(it.qty);
      const unit = money2(num(it.price));
      const cost = money2(num(it.cost));
      rows.push([
        localDate(o.createdAt), localTime(o.createdAt), o.id,
        orderChannel(o) === 'pos' ? 'In-store' : 'Online',
        o.status, counts ? 'yes' : 'no',
        it.name ?? 'item', it.category ?? '',
        qty, unit.toFixed(2), money2(unit * qty).toFixed(2),
        cost ? cost.toFixed(2) : '', cost ? money2((unit - cost) * qty).toFixed(2) : '',
        o.customerName ?? '',
      ]);
    }
  }

  return toCsv(
    ['Date', 'Time', 'Order', 'Channel', 'Status', 'Counts as revenue',
     'Product', 'Category', 'Qty', 'Unit price', 'Line total',
     'Unit cost', 'Line profit', 'Customer'],
    rows,
  );
}

export interface TopProduct { name: string; units: number; revenue: number; }

/** Best sellers across the period, by revenue. Revenue orders only. */
export function topProducts(orders: ExportOrder[], limit = 25): TopProduct[] {
  const by = new Map<string, TopProduct>();
  for (const o of orders) {
    if (!isRevenueOrder(o)) continue;
    for (const it of o.items ?? []) {
      const name = it.name ?? 'item';
      const row  = by.get(name) ?? { name, units: 0, revenue: 0 };
      row.units  += num(it.qty);
      row.revenue = money2(row.revenue + num(it.price) * num(it.qty));
      by.set(name, row);
    }
  }
  return Array.from(by.values()).sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

/** Revenue per calendar day (Mogadishu time), oldest first. */
export function dailyBreakdown(orders: ExportOrder[]): { date: string; orders: number; units: number; revenue: number; cost: number }[] {
  const by = new Map<string, { date: string; orders: number; units: number; revenue: number; cost: number }>();
  for (const o of orders) {
    if (!isRevenueOrder(o)) continue;
    const date = localDate(o.createdAt);
    if (!date) continue;
    const row = by.get(date) ?? { date, orders: 0, units: 0, revenue: 0, cost: 0 };
    row.orders  += 1;
    row.units   += orderUnits(o);
    row.revenue  = money2(row.revenue + num(o.total));
    row.cost     = money2(row.cost + orderCost(o));
    by.set(date, row);
  }
  return Array.from(by.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export interface DashboardCsvInput {
  storeName:  string;
  rangeLabel: string;
  generatedAt: Date;
  orders:     ExportOrder[];
  /** Outstanding customer credit at export time, if the ledger was loaded. */
  owed?:      { customers: number; outstanding: number };
}

/**
 * The headline sheet: KPIs, the day-by-day breakdown, and best sellers in one
 * file. Sections are separated by a blank line — every spreadsheet handles that,
 * and it keeps a store's whole picture in a single openable document.
 */
export function dashboardSummaryCsv(input: DashboardCsvInput): string {
  const { storeName, rangeLabel, generatedAt, orders, owed } = input;
  const t = summariseOrders(orders);

  const head = [
    ['Store', storeName],
    ['Period', rangeLabel],
    ['Generated', `${localDate(generatedAt.toISOString())} ${localTime(generatedAt.toISOString())}`],
    [],
    ['SUMMARY'],
    ['Revenue', t.revenue.toFixed(2)],
    ['Cost of goods', t.cost.toFixed(2)],
    ['Profit', t.profit.toFixed(2)],
    ['Margin %', String(t.marginPct)],
    ['Orders', String(t.orders)],
    ['Units sold', String(t.units)],
    ['Average order', t.avgOrder.toFixed(2)],
    ['Online revenue', t.online.toFixed(2)],
    ['In-store revenue', t.inStore.toFixed(2)],
    ['Excluded orders (deleted/cancelled/refunded)', String(t.excluded)],
  ];
  if (owed) {
    head.push(['Customers owing money', String(owed.customers)]);
    head.push(['Total outstanding credit', owed.outstanding.toFixed(2)]);
  }

  const lines = head.map(r => r.map(csvCell).join(','));

  lines.push('');
  lines.push('BY DAY');
  lines.push(['Date', 'Orders', 'Units', 'Revenue', 'Cost', 'Profit'].map(csvCell).join(','));
  for (const d of dailyBreakdown(orders)) {
    lines.push([d.date, d.orders, d.units, d.revenue.toFixed(2), d.cost.toFixed(2),
                money2(d.revenue - d.cost).toFixed(2)].map(csvCell).join(','));
  }

  lines.push('');
  lines.push('TOP PRODUCTS');
  lines.push(['Product', 'Units', 'Revenue'].map(csvCell).join(','));
  for (const p of topProducts(orders)) {
    lines.push([p.name, p.units, p.revenue.toFixed(2)].map(csvCell).join(','));
  }

  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Filesystem-safe slug for a store folder inside the archive. */
export function storeSlug(name: string, id: number | string): string {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'store'}-${id}`;
}
