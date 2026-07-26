// READ-ONLY business analysis of the live Hamar Mall database.
// Uses the service-role key (bypasses RLS) to pull aggregate metrics on
// sellers, products, orders, and monetization. No writes anywhere.
//
//   node scripts/analyze-business.mjs
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Load .env.local the way Next does (simple parser — no dotenv dep needed).
const envFile = fs.readFileSync(path.resolve('.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const URL   = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing Supabase URL or service role key in .env.local'); process.exit(1); }

const supa = createClient(URL, KEY, { auth: { persistSession: false } });
const money = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ── Pull full datasets (the app is small/early; safe to fetch rows) ──
async function all(table, select = '*', opts = {}) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supa.from(table).select(select, { count: 'exact' })
      .range(from, from + 999).order('id' in (opts.orderKey ?? { id: 1 }) ? 'id' : 'created_at');
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

console.log('Fetching live data…\n');

// ── Sellers (suppliers) ──
const { data: sellersRaw, error: eS } = await supa.from('suppliers').select('*');
if (eS) { console.error('suppliers:', eS.message); process.exit(1); }
const sellers = sellersRaw || [];

// ── Products (global catalog) ──
const { data: productsRaw, error: eP } = await supa.from('products').select('*');
if (eP) { console.error('products:', eP.message); process.exit(1); }
const products = productsRaw || [];

// ── Business products (sellers' claimed catalog rows) ──
const { data: bizProductsRaw, error: eBP } = await supa.from('business_products').select('*');
const bizProducts = bizProductsRaw || [];

// ── Orders ──
const { data: ordersRaw, error: eO } = await supa.from('orders').select('*');
if (eO) { console.error('orders:', eO.message); process.exit(1); }
const orders = ordersRaw || [];

// ── Order items (normalized lines) ──
const { data: orderItemsRaw, error: eOI } = await supa.from('order_items').select('*');
const orderItems = orderItemsRaw || [];

// ── Subscription events (monetization ledger) ──
const { data: subEventsRaw, error: eSE } = await supa.from('subscription_events').select('*');
const subEvents = subEventsRaw || [];

// ── Payouts ──
const { data: payoutsRaw, error: ePayout } = await supa.from('payouts').select('*');
const payouts = payoutsRaw || [];

// ── Reviews ──
const { data: reviewsRaw, error: eR } = await supa.from('reviews').select('*');
const reviews = reviewsRaw || [];

// ── Customers (POS walk-in book) ──
const { data: customersRaw, error: eC } = await supa.from('customers').select('*');
const customers = customersRaw || [];

// ════════════════════════════════════════════════════════════════════
// SELLERS
// ════════════════════════════════════════════════════════════════════
console.log('════════════════ SELLERS ════════════════════════\n');
const byType = {};
sellers.forEach(s => { byType[s.account_type] = (byType[s.account_type] || 0) + 1; });
const verified = sellers.filter(s => s.verified).length;
const noAuth   = sellers.filter(s => !s.auth_user_id).length;
const withSlug = sellers.filter(s => s.slug).length;
const withLoc  = sellers.filter(s => s.latitude != null && s.longitude != null).length;
const withPhone = sellers.filter(s => (s.contact_numbers || []).length > 0).length;
console.log(`Total seller rows:        ${sellers.length}`);
console.log(`  by account type:        ${JSON.stringify(byType)}`);
console.log(`  verified (✓):           ${verified} / ${sellers.length}`);
console.log(`  have a public slug:     ${withSlug}`);
console.log(`  have GPS location:      ${withLoc}`);
console.log(`  have a contact number:  ${withPhone}`);
console.log(`  no auth_user_id (demo): ${noAuth}`);

// subscription health
const paidSellers = sellers.filter(s => s.subscription_paid_at);
const grandfathered = paidSellers.filter(s => new Date(s.subscription_paid_at) <= new Date(s.created_at.getTime ? s.created_at.getTime() : Date.parse(s.created_at) + 1000));
console.log(`\n  paid_at set:            ${paidSellers.length} / ${sellers.length}`);
// trial window = 7 days; period = 30 days. Count those actually within 7d of paying.
const now = Date.now();
const inTrial = paidSellers.filter(s => s.subscription_paid_at && (now - Date.parse(s.subscription_paid_at)) < 7*86400000);
console.log(`  currently in 7d trial:  ${inTrial.length}`);

// ════════════════════════════════════════════════════════════════════
// PRODUCTS / CATALOG
// ════════════════════════════════════════════════════════════════════
console.log('\n════════════════ PRODUCTS / CATALOG ═════════════');
const cats = {};
products.forEach(p => { cats[p.category] = (cats[p.category] || 0) + 1; });
const noSupplier = products.filter(p => p.supplier_id == null).length;
const zeroStock  = products.filter(p => Number(p.stock) <= 0).length;
const noImage    = products.filter(p => !p.image_url && (p.image_urls || []).length === 0).length;
const noBarcode  = products.filter(p => !p.barcode).length;
const noCost     = products.filter(p => Number(p.cost) <= 0).length;
const zeroPrice  = products.filter(p => Number(p.price) <= 0).length;
const noReviews  = products.filter(p => Number(p.reviews) <= 0).length;
const noSold     = products.filter(p => Number(p.sold) <= 0).length;
const priceLTcost= products.filter(p => Number(p.cost) > 0 && Number(p.price) < Number(p.cost));
const b2b        = products.filter(p => p.is_b2b).length;
console.log(`Catalog products:         ${products.length}`);
console.log(`  categories (${Object.keys(cats).length}):      ${JSON.stringify(cats)}`);
console.log(`  no supplier assigned:   ${noSupplier}`);
console.log(`  zero stock:             ${zeroStock}`);
console.log(`  no image at all:        ${noImage}`);
console.log(`  no barcode:             ${noBarcode}`);
console.log(`  no cost recorded:       ${noCost}  (can't compute profit on these)`);
console.log(`  zero price:             ${zeroPrice}`);
console.log(`  price < cost (loss):    ${priceLTcost.length}`);
console.log(`  never sold:             ${noSold}`);
console.log(`  no reviews:             ${noReviews}`);
console.log(`  is_b2b (wholesale):     ${b2b}`);
console.log(`  business_products rows: ${bizProducts.length}  (sellers' claimed catalog)`);

// which sellers actually have catalog
const sellersWithProducts = new Set(bizProducts.map(bp => bp.supplier_id));
const sellersWithNoListing = sellers.filter(s => !sellersWithProducts.has(s.id) && (s.account_type === 'business' || s.account_type === 'supplier'));
console.log(`  sellers with 0 listings: ${sellersWithNoListing.length} / ${sellers.length}`);

// ════════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════════
console.log('\n════════════════ ORDERS ════════════════════════');
const activeOrders = orders.filter(o => o.status !== 'deleted');
const byStatus = {};
activeOrders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
const byPay = {};
activeOrders.forEach(o => { byPay[o.payment_method] = (byPay[o.payment_method] || 0) + 1; });
const gmV = activeOrders.reduce((a, o) => a + Number(o.total), 0);
const gmVonline = activeOrders.filter(o => ['sifalo','waafi','evc','edahab'].includes((o.payment_method||'').toLowerCase())).reduce((a,o)=>a+Number(o.total),0);
console.log(`Total orders:             ${orders.length}  (active ${activeOrders.length}, deleted ${orders.length - activeOrders.length})`);
console.log(`  by status:              ${JSON.stringify(byStatus)}`);
console.log(`  by payment method:      ${JSON.stringify(byPay)}`);
console.log(`  gross merchandise value:$${money(gmV)}`);
console.log(`  of which online-paid:    $${money(gmVonline)}`);

// order recency
if (activeOrders.length) {
  const ts = activeOrders.map(o => Date.parse(o.created_at)).filter(Boolean).sort();
  const newest = new Date(ts[ts.length-1]);
  const oldest = new Date(ts[0]);
  console.log(`  oldest order:           ${oldest.toISOString().slice(0,10)}`);
  console.log(`  newest order:           ${newest.toISOString().slice(0,10)}`);
  // orders in last 7 / 30 days
  const last7 = activeOrders.filter(o => (now - Date.parse(o.created_at)) < 7*86400000).length;
  const last30 = activeOrders.filter(o => (now - Date.parse(o.created_at)) < 30*86400000).length;
  console.log(`  orders last 7 days:     ${last7}`);
  console.log(`  orders last 30 days:    ${last30}`);
}

// fulfillment health: stuck orders
const pending = activeOrders.filter(o => o.status === 'pending').length;
const processing = activeOrders.filter(o => o.status === 'processing').length;
const stuckOld = activeOrders.filter(o => ['pending','processing'].includes(o.status) && (now - Date.parse(o.created_at)) > 3*86400000);
console.log(`  stuck >3d (pend/proc):  ${stuckOld.length}`);

// ════════════════════════════════════════════════════════════════════
// MONETIZATION
// ════════════════════════════════════════════════════════════════════
console.log('\n════════════════ MONETIZATION ══════════════════');
const subPayments = subEvents.filter(e => e.kind === 'payment');
const subRefunds  = subEvents.filter(e => e.kind === 'refund');
const subRevenue  = subPayments.reduce((a,e)=>a+Number(e.amount),0) - subRefunds.reduce((a,e)=>a+Number(e.amount),0);
console.log(`Subscription payments:    ${subPayments.length}  ($${money(subPayments.reduce((a,e)=>a+Number(e.amount),0))})`);
console.log(`Subscription refunds:     ${subRefunds.length}  ($${money(subRefunds.reduce((a,e)=>a+Number(e.amount),0))})`);
console.log(`Net subscription revenue: $${money(subRevenue)}`);
const payoutsTotal = payouts.reduce((a,p)=>a+Number(p.amount),0);
console.log(`Payouts requested:       ${payouts.length}  ($${money(payoutsTotal)})`);

// order_items revenue by supplier
const revBySupplier = {};
orderItems.forEach(oi => { revBySupplier[oi.supplier_id] = (revBySupplier[oi.supplier_id]||0) + Number(oi.line_total); });
const topSellers = Object.entries(revBySupplier).sort((a,b)=>b[1]-a[1]).slice(0,5);
if (topSellers.length) {
  console.log(`\nTop sellers by line revenue (order_items):`);
  topSellers.forEach(([sid, rev]) => {
    const s = sellers.find(x => String(x.id) === String(sid));
    console.log(`  ${s ? s.name.padEnd(28) : ('supplier #'+sid).padEnd(28)} $${money(rev)}`);
  });
}

// ════════════════════════════════════════════════════════════════════
// ENGAGEMENT
// ════════════════════════════════════════════════════════════════════
console.log('\n════════════════ ENGAGEMENT ════════════════════');
console.log(`Reviews:                  ${reviews.length}`);
console.log(`POS customers in book:    ${customers.length}`);

// order_items coverage: how many orders have normalized lines?
const ordersWithLines = new Set(orderItems.map(oi => oi.order_id));
console.log(`\norders with order_items:  ${ordersWithLines.size} / ${orders.length}`);

console.log('\nDone.');
