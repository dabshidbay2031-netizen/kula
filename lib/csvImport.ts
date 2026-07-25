/**
 * Product CSV bulk import.
 *
 * The previous importer split each line on every comma, so a single quoted
 * field containing a comma ("Durable, waterproof boots") silently shifted every
 * later column — the price landed in `category`, and so on. This module parses
 * CSV properly (quotes, escaped quotes, embedded commas and newlines, CRLF, BOM)
 * and maps a row onto the product payload.
 */

/** Canonical column order for the downloadable template. */
export const PRODUCT_CSV_COLUMNS = [
  'name', 'price', 'cost', 'original_price', 'category', 'sub_category',
  'stock', 'sku', 'barcode', 'brand', 'tags', 'tax_mode', 'moq',
  'image_url', 'description',
] as const;

/**
 * The template a seller downloads. Row 1 is the header; the sample rows show a
 * fully-populated product and a minimal one (only name + price are required),
 * including a description with a comma so the quoting rule is self-evident.
 */
export const PRODUCT_CSV_TEMPLATE = [
  PRODUCT_CSV_COLUMNS.join(','),
  [
    'Sony WH-1000XM5', '399.99', '250.00', '449.99', 'electronics', 'audio',
    '25', 'SNY-WH1000XM5', '027242923497', 'Sony', 'wireless|noise-cancelling|bluetooth',
    'excluded', '1', 'https://example.com/photo.jpg',
    '"Industry-leading noise cancellation, 30-hour battery"',
  ].join(','),
  [
    'Paracetamol 500mg', '0.60', '0.35', '', 'health', 'medicine',
    '500', 'PAR-500', '', 'Generic', 'pain-relief|tablets',
    'none', '1', '', 'Box of 100 tablets',
  ].join(','),
].join('\n');

/**
 * Parse a CSV document into row objects keyed by normalised header name.
 * Handles: quoted fields, "" escapes, commas/newlines inside quotes, CRLF and a
 * UTF-8 BOM. Returns [] when there's no data row.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, ''); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"')       { inQuotes = true; }
    else if (ch === ',')  { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* handled with the \n */ }
    else                  { field += ch; }
  }
  // last field / row (file may not end with a newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
  if (nonEmpty.length < 2) return [];

  const headers = nonEmpty[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return nonEmpty.slice(1).map(cells => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

export interface ProductImportPayload {
  name: string; price: number; cost: number; originalPrice: number;
  category: string; subCategory: string | null; stock: number; sku: string;
  barcode: string | null; brand: string | null; tags: string[];
  taxMode: 'none' | 'included' | 'excluded'; moq: number;
  imageUrl: string | null; imageUrls: string[]; description: string;
}

const TAX_MODES = new Set(['none', 'included', 'excluded']);

/**
 * Map one parsed row onto a product payload, or return null when the row can't
 * be a product (no name, or no usable price). Column aliases are accepted so a
 * seller can hand us an export from another system without re-typing headers.
 */
export function csvRowToProduct(row: Record<string, string>, index = 0): ProductImportPayload | null {
  const name = (row.name || row.product_name || row.title || '').trim();
  const price = parseFloat(row.price || row.selling_price || row.unit_price || '');
  if (!name || !Number.isFinite(price) || price < 0) return null;

  const num = (v: string | undefined, fallback = 0) => {
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const images = (row.image_urls || row.images || '')
    .split('|').map(s => s.trim()).filter(Boolean);
  const primary = (row.image_url || row.image || '').trim() || images[0] || null;
  const allImages = primary ? [primary, ...images.filter(u => u !== primary)] : images;

  const taxRaw = (row.tax_mode || row.tax || '').trim().toLowerCase();

  return {
    name,
    price,
    cost:          num(row.cost || row.buy_price),
    originalPrice: num(row.original_price || row.compare_price || row.rrp, price),
    category:      (row.category || 'other').trim().toLowerCase(),
    subCategory:   (row.sub_category || row.subcategory || '').trim() || null,
    stock:         Math.trunc(num(row.stock || row.quantity || row.qty)),
    sku:           (row.sku || '').trim() || `CSV-${Date.now()}-${index}`,
    barcode:       (row.barcode || row.ean || row.upc || '').trim() || null,
    brand:         (row.brand || row.manufacturer || '').trim() || null,
    tags:          (row.tags || '').split('|').map(t => t.trim()).filter(Boolean),
    taxMode:       (TAX_MODES.has(taxRaw) ? taxRaw : 'none') as ProductImportPayload['taxMode'],
    moq:           Math.max(1, Math.trunc(num(row.moq, 1))),
    imageUrl:      primary,
    imageUrls:     allImages,
    description:   (row.description || row.details || '').trim(),
  };
}
