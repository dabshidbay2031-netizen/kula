import { describe, it, expect } from 'vitest';
import {
  money2, outstanding, csvCell, toCsv, summarise, summaryCsv, detailCsv,
  totals, exportFileName, type ExportInvoice,
} from '@/lib/creditExport';

const inv = (o: Partial<ExportInvoice> & { id: string }): ExportInvoice => ({
  customerId: 'c1', customerName: 'Xasan', total: 100, paidTotal: 0,
  status: 'unpaid', notes: null, createdAt: '2026-07-01T10:00:00Z', ...o,
});

describe('money', () => {
  it('rounds to cents instead of trusting floating point', () => {
    expect(money2(0.1 + 0.2)).toBe(0.3);
    expect(money2(10.005)).toBe(10.01);
  });

  it('never reports a negative debt when a customer overpays', () => {
    expect(outstanding({ total: 100, paidTotal: 130 })).toBe(0);
  });

  it('computes a partial balance exactly', () => {
    expect(outstanding({ total: 99.99, paidTotal: 33.33 })).toBe(66.66);
  });
});

describe('CSV safety', () => {
  it('quotes a name containing a comma so columns do not shift', () => {
    expect(csvCell('Xasan, Jr')).toBe('"Xasan, Jr"');
  });

  it('escapes embedded quotes', () => {
    expect(csvCell('Xasan "Cadde"')).toBe('"Xasan ""Cadde"""');
  });

  it('handles newlines inside a note', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises a formula so Excel does not execute it', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 600')).toBe("'+44 600");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('writes a BOM and CRLF so Excel reads UTF-8 correctly', () => {
    const csv = toCsv(['A'], [['Cabdiraxmaan']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
  });

  it('keeps a comma-bearing name intact through a full round trip', () => {
    const csv = detailCsv([inv({ id: 'INV-1', customerName: 'Xasan, Jr' })]);
    const line = csv.split('\r\n')[1];
    expect(line).toContain('"Xasan, Jr"');
    expect(line.split(',').length).toBeGreaterThan(8);   // still one row
  });
});

describe('per-customer summary', () => {
  const invoices = [
    inv({ id: 'A', customerId: 'c1', total: 100, paidTotal: 40, createdAt: '2026-07-01T00:00:00Z' }),
    inv({ id: 'B', customerId: 'c1', total: 50,  paidTotal: 50, status: 'paid', createdAt: '2026-07-10T00:00:00Z' }),
    inv({ id: 'C', customerId: 'c2', customerName: 'Faadumo', total: 200, paidTotal: 0, createdAt: '2026-07-05T00:00:00Z' }),
  ];

  it('rolls each customer up once', () => {
    const rows = summarise(invoices);
    expect(rows.length).toBe(2);
  });

  it('sorts biggest debt first — the list a shop chases', () => {
    const rows = summarise(invoices);
    expect(rows[0].customerName).toBe('Faadumo');
    expect(rows[0].outstanding).toBe(200);
  });

  it('sums billed, paid and outstanding correctly', () => {
    const c1 = summarise(invoices).find(r => r.customerId === 'c1')!;
    expect(c1.invoices).toBe(2);
    expect(c1.billed).toBe(150);
    expect(c1.paid).toBe(90);
    expect(c1.outstanding).toBe(60);
  });

  it('reports the OLDEST unpaid invoice, ignoring settled ones', () => {
    const c1 = summarise(invoices).find(r => r.customerId === 'c1')!;
    expect(c1.oldestUnpaid).toBe('2026-07-01T00:00:00Z');
    expect(c1.lastActivity).toBe('2026-07-10T00:00:00Z');
  });

  it('attaches the phone number so the debt can be chased', () => {
    const rows = summarise(invoices, [{ id: 'c1', name: 'Xasan', phone: '+252611' }]);
    expect(rows.find(r => r.customerId === 'c1')!.phone).toBe('+252611');
  });

  it('totals across every customer', () => {
    const t = totals(summarise(invoices));
    expect(t.customers).toBe(2);
    expect(t.invoices).toBe(3);
    expect(t.billed).toBe(350);
    expect(t.outstanding).toBe(260);
  });
});

describe('file output', () => {
  it('emits a header plus one line per customer', () => {
    const csv = summaryCsv(summarise([inv({ id: 'A' })]));
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('Outstanding');
  });

  it('emits every invoice in the detail ledger, newest first', () => {
    const csv = detailCsv([
      inv({ id: 'OLD', createdAt: '2026-01-01T00:00:00Z' }),
      inv({ id: 'NEW', createdAt: '2026-07-01T00:00:00Z' }),
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain('NEW');
    expect(lines[2]).toContain('OLD');
  });

  it('names the file so daily backups do not overwrite each other', () => {
    const n = exportFileName('City Care Pharmacy', 'daily', new Date('2026-07-27T09:00:00Z'));
    expect(n).toBe('credits-daily-city-care-pharmacy-2026-07-27.csv');
  });
});
