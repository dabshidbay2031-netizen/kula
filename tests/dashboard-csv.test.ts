// @vitest-environment node
/**
 * Dashboard CSV export.
 *
 * This file IS the backup. If the numbers here disagree with the dashboard, or
 * a cancelled order quietly counts as revenue, a shop reconciles against a lie —
 * so the revenue rules and the escaping are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  summariseOrders, ordersCsv, soldItemsCsv, dashboardSummaryCsv,
  topProducts, dailyBreakdown, orderUnits, orderCost, storeSlug,
  type ExportOrder,
} from '@/lib/dashboardCsv';

const mk = (over: Partial<ExportOrder> = {}): ExportOrder => ({
  id: 'ORD-1',
  createdAt: '2026-03-04T09:00:00+03:00',
  status: 'completed',
  total: 100,
  items: [{ name: 'Rice', qty: 2, price: 30, cost: 20 }, { name: 'Oil', qty: 1, price: 40, cost: 25 }],
  ...over,
});

describe('revenue rules match the dashboard', () => {
  it('excludes cancelled, refunded and deleted orders from money', () => {
    const t = summariseOrders([
      mk({ id: 'a', total: 100 }),
      mk({ id: 'b', total: 999, status: 'cancelled' }),
      mk({ id: 'c', total: 999, status: 'refunded' }),
      mk({ id: 'd', total: 999, status: 'deleted' }),
    ]);
    expect(t.revenue).toBe(100);
    expect(t.orders).toBe(1);
    expect(t.excluded).toBe(3);
  });

  it('splits online vs in-store by POS session or cashier', () => {
    const t = summariseOrders([
      mk({ id: 'a', total: 50 }),                              // online
      mk({ id: 'b', total: 70, sessionId: 'sess-1' }),         // register
      mk({ id: 'c', total: 30, cashierName: 'Hodan' }),        // register
    ]);
    expect(t.online).toBe(50);
    expect(t.inStore).toBe(100);
    expect(t.revenue).toBe(150);
  });

  it('computes profit from recorded costs only', () => {
    const t = summariseOrders([mk({ total: 100 })]);            // cost 2×20 + 1×25 = 65
    expect(t.cost).toBe(65);
    expect(t.profit).toBe(35);
    expect(t.marginPct).toBe(35);
  });

  it('never invents profit when cost is missing', () => {
    const t = summariseOrders([mk({ items: [{ name: 'X', qty: 1, price: 50 }], total: 50 })]);
    expect(t.cost).toBe(0);
    expect(t.profit).toBe(50);      // unknown cost, not a guessed one
  });

  it('counts units, not line items', () => {
    expect(orderUnits(mk())).toBe(3);
    expect(orderCost(mk())).toBe(65);
  });

  it('averages only over revenue-counting orders', () => {
    const t = summariseOrders([
      mk({ id: 'a', total: 100 }), mk({ id: 'b', total: 200 }),
      mk({ id: 'c', total: 900, status: 'cancelled' }),
    ]);
    expect(t.avgOrder).toBe(150);
  });

  it('an empty period is zero, not NaN', () => {
    const t = summariseOrders([]);
    expect(t.revenue).toBe(0);
    expect(t.avgOrder).toBe(0);
    expect(t.marginPct).toBe(0);
  });

  it('does not accumulate floating-point dust across many orders', () => {
    const t = summariseOrders(Array.from({ length: 3 }, (_, i) =>
      mk({ id: `o${i}`, total: 0.1, items: [] })));
    expect(t.revenue).toBe(0.3);
  });
});

describe('orders.csv', () => {
  it('flags non-revenue rows instead of dropping them', () => {
    const csv = ordersCsv([mk({ id: 'KEEP', total: 100 }), mk({ id: 'GONE', total: 999, status: 'cancelled' })]);
    expect(csv).toContain('KEEP');
    expect(csv).toContain('GONE');
    // the cancelled row is present but contributes no money
    const gone = csv.split('\r\n').find(l => l.includes('GONE'))!;
    expect(gone).toContain('no');
    expect(gone).toContain('0.00');
    expect(gone).not.toContain('999');
  });

  it('labels the channel in words a shopkeeper reads', () => {
    const csv = ordersCsv([mk({ sessionId: 'sess-1' })]);
    expect(csv).toContain('In-store');
  });
});

describe('items-sold.csv — "whatever they sold"', () => {
  it('emits one row per line item with quantities and line totals', () => {
    const csv = soldItemsCsv([mk()]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);                 // header + 2 items
    expect(lines[1]).toContain('Rice');
    expect(lines[1]).toContain('60.00');           // 2 × 30
    expect(lines[2]).toContain('Oil');
  });

  it('handles an order with no items without producing a phantom row', () => {
    expect(soldItemsCsv([mk({ items: [] })]).trim().split('\r\n')).toHaveLength(1);
  });
});

describe('CSV safety', () => {
  it('quotes a product name containing a comma and a quote', () => {
    const csv = soldItemsCsv([mk({ items: [{ name: 'Rice, "Basmati"', qty: 1, price: 5 }] })]);
    expect(csv).toContain('"Rice, ""Basmati"""');
  });

  it('neutralises a formula-injection product name', () => {
    const csv = soldItemsCsv([mk({ items: [{ name: '=cmd|calc', qty: 1, price: 1 }] })]);
    expect(csv).toContain("'=cmd|calc");
  });

  it('starts with a BOM so Excel reads Somali names correctly', () => {
    expect(ordersCsv([mk()]).charCodeAt(0)).toBe(0xfeff);
  });
});

describe('aggregations', () => {
  it('ranks top products by revenue, ignoring cancelled orders', () => {
    const top = topProducts([
      mk({ id: 'a', items: [{ name: 'Rice', qty: 1, price: 10 }] }),
      mk({ id: 'b', items: [{ name: 'Oil',  qty: 1, price: 40 }] }),
      mk({ id: 'c', status: 'cancelled', items: [{ name: 'Ghost', qty: 99, price: 99 }] }),
    ]);
    expect(top.map(t => t.name)).toEqual(['Oil', 'Rice']);
  });

  it('buckets revenue by Mogadishu calendar day, oldest first', () => {
    const rows = dailyBreakdown([
      mk({ id: 'a', createdAt: '2026-03-05T09:00:00+03:00', total: 20, items: [] }),
      mk({ id: 'b', createdAt: '2026-03-04T09:00:00+03:00', total: 10, items: [] }),
      // 23:30 Mogadishu on the 4th — must land on the 4th, not the 5th
      mk({ id: 'c', createdAt: '2026-03-04T23:30:00+03:00', total: 5,  items: [] }),
    ]);
    expect(rows.map(r => r.date)).toEqual(['2026-03-04', '2026-03-05']);
    expect(rows[0].revenue).toBe(15);
  });
});

describe('dashboard.csv', () => {
  it('carries the headline figures and both extra sections', () => {
    const csv = dashboardSummaryCsv({
      storeName: 'Sokow Sambusa',
      rangeLabel: '4 Mar 2026',
      generatedAt: new Date('2026-03-05T10:00:00Z'),
      orders: [mk()],
      owed: { customers: 2, outstanding: 12.5 },
    });
    expect(csv).toContain('Sokow Sambusa');
    expect(csv).toContain('SUMMARY');
    expect(csv).toContain('BY DAY');
    expect(csv).toContain('TOP PRODUCTS');
    expect(csv).toContain('Total outstanding credit,12.50');
  });

  it('omits the credit lines when the store keeps no ledger', () => {
    const csv = dashboardSummaryCsv({
      storeName: 'X', rangeLabel: 'all', generatedAt: new Date(), orders: [mk()],
    });
    expect(csv).not.toContain('Total outstanding credit');
  });
});

describe('storeSlug', () => {
  it('stays filesystem-safe and keeps ids distinct for same-named stores', () => {
    expect(storeSlug('Sokow Sambusa!', 7)).toBe('sokow-sambusa-7');
    expect(storeSlug('', 9)).toBe('store-9');
    expect(storeSlug('Cadde & Sons', 3)).toBe('cadde-sons-3');
  });
});
