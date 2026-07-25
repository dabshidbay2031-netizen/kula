// @vitest-environment node
/**
 * The old importer split every line on ',', so one quoted description with a
 * comma shifted every later column (price landed in `category`). These tests
 * pin the parser down and cover the template we hand sellers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCsv, csvRowToProduct, PRODUCT_CSV_TEMPLATE, PRODUCT_CSV_COLUMNS,
} from '@/lib/csvImport';

describe('parseCsv', () => {
  it('keeps commas that live inside quoted fields', () => {
    const rows = parseCsv('name,price,description\nBoots,9.99,"Durable, waterproof boots"');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Boots');
    expect(rows[0].price).toBe('9.99');           // ← the column that used to shift
    expect(rows[0].description).toBe('Durable, waterproof boots');
  });

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('name,description\nMug,"He said ""hello"""');
    expect(rows[0].description).toBe('He said "hello"');
  });

  it('supports newlines inside quoted fields', () => {
    const rows = parseCsv('name,description\nItem,"line one\nline two"');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('line one\nline two');
  });

  it('handles CRLF endings and a UTF-8 BOM', () => {
    const rows = parseCsv('﻿name,price\r\nWidget,5.00\r\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Widget');
    expect(rows[0].price).toBe('5.00');
  });

  it('normalises header names and ignores blank lines', () => {
    const rows = parseCsv('Product Name,Sub-Category\n\nThing,audio\n');
    expect(rows[0]).toHaveProperty('product_name', 'Thing');
    expect(rows[0]).toHaveProperty('sub_category', 'audio');
  });

  it('returns nothing when there is no data row', () => {
    expect(parseCsv('name,price')).toEqual([]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('csvRowToProduct', () => {
  it('rejects rows without a usable name or price', () => {
    expect(csvRowToProduct({ name: '', price: '5' })).toBeNull();
    expect(csvRowToProduct({ name: 'X', price: '' })).toBeNull();
    expect(csvRowToProduct({ name: 'X', price: 'abc' })).toBeNull();
    expect(csvRowToProduct({ name: 'X', price: '-3' })).toBeNull();
  });

  it('maps a full row, splitting tags on |', () => {
    const p = csvRowToProduct({
      name: 'Sony', price: '399.99', cost: '250', original_price: '449.99',
      category: 'Electronics', sub_category: 'audio', stock: '25', sku: 'S-1',
      barcode: '027242923497', brand: 'Sony', tags: 'wireless|bluetooth',
      tax_mode: 'excluded', moq: '2', image_url: 'https://x/a.jpg', description: 'Nice',
    })!;
    expect(p.price).toBe(399.99);
    expect(p.cost).toBe(250);
    expect(p.category).toBe('electronics');       // lower-cased
    expect(p.tags).toEqual(['wireless', 'bluetooth']);
    expect(p.taxMode).toBe('excluded');
    expect(p.moq).toBe(2);
    expect(p.imageUrls).toEqual(['https://x/a.jpg']);
  });

  it('defaults sensibly: originalPrice falls back to price, moq to 1, tax to none', () => {
    const p = csvRowToProduct({ name: 'X', price: '10' })!;
    expect(p.originalPrice).toBe(10);
    expect(p.moq).toBe(1);
    expect(p.taxMode).toBe('none');
    expect(p.cost).toBe(0);
    expect(p.category).toBe('other');
    expect(p.sku).toMatch(/^CSV-/);               // generated when absent
  });

  it('rejects an unknown tax mode rather than passing it through', () => {
    expect(csvRowToProduct({ name: 'X', price: '1', tax_mode: 'vat-ish' })!.taxMode).toBe('none');
  });

  it('accepts common aliases from other systems', () => {
    const p = csvRowToProduct({ product_name: 'Aliased', selling_price: '7.50', qty: '4', ean: '123' })!;
    expect(p.name).toBe('Aliased');
    expect(p.price).toBe(7.5);
    expect(p.stock).toBe(4);
    expect(p.barcode).toBe('123');
  });
});

describe('PRODUCT_CSV_TEMPLATE', () => {
  it('round-trips through the parser into valid products', () => {
    const rows = parseCsv(PRODUCT_CSV_TEMPLATE);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(csvRowToProduct(r)).not.toBeNull();
  });

  it('has a header matching the documented column order', () => {
    expect(PRODUCT_CSV_TEMPLATE.split('\n')[0]).toBe(PRODUCT_CSV_COLUMNS.join(','));
  });

  it('demonstrates the quoting rule with a comma in a description', () => {
    const rows = parseCsv(PRODUCT_CSV_TEMPLATE);
    expect(rows.some(r => r.description.includes(','))).toBe(true);
    // and that row must still parse its price correctly
    const withComma = rows.find(r => r.description.includes(','))!;
    expect(Number.isFinite(parseFloat(withComma.price))).toBe(true);
  });
});
