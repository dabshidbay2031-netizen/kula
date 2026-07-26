// Deeper probe: distinguish REAL activity from seed/test data.
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envFile = fs.readFileSync(path.resolve('.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const money = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

const { data: sellers } = await supa.from('suppliers').select('*');
const { data: orders }  = await supa.from('orders').select('*');
const { data: ois }     = await supa.from('order_items').select('*');
const { data: subs }    = await supa.from('subscription_events').select('*');
const { data: prods }   = await supa.from('products').select('*');
const { data: bizp }    = await supa.from('business_products').select('*');

// ── 1. SELLER provenance: which look like seeded niche businesses? ──
console.log('══ SELLER PROVENANCE ══');
const seededPatt = /^(the|biz\.|sup\.)|sambusa|store|test|demo|niche/i;
const seededNames = sellers.filter(s => seededPatt.test(s.name));
console.log(`sellers whose name matches seed/test pattern: ${seededNames.length}`);
console.log(`  examples: ${seededNames.slice(0,15).map(s=>s.name).join(' | ')}`);

// sellers created in last 14 days = likely real recent signups
const now = Date.now();
const realishSellers = sellers.filter(s => !seededPatt.test(s.name));
const recentSellers = realishSellers.filter(s => (now - Date.parse(s.created_at)) < 14*86400000);
console.log(`\nnon-seed-pattern sellers: ${realishSellers.length}`);
realishSellers.forEach(s => console.log(`  • ${s.name.padEnd(24)} ${s.account_type.padEnd(9)} created ${s.created_at.slice(0,10)} ${s.verified?'✓':''} paid:${s.subscription_paid_at?s.subscription_paid_at.slice(0,10):'no'}`));

// ── 2. ORDERS: are totals consistent with order_items? ──
console.log('\n══ ORDER TOTALS vs LINE ITEMS ══');
const sumByOrder = {};
ois.forEach(oi => { sumByOrder[oi.order_id] = (sumByOrder[oi.order_id]||0) + Number(oi.line_total); });
const ordersWithLines = orders.filter(o => sumByOrder[o.id] != null);
const ordersNoLines   = orders.filter(o => sumByOrder[o.id] == null && o.status !== 'deleted');
console.log(`orders WITH order_items lines: ${ordersWithLines.length}`);
console.log(`orders WITHOUT (legacy items JSONB only): ${ordersNoLines.length}`);
const gmvWith = ordersWithLines.reduce((a,o)=>a+Number(o.total),0);
const gmvWithout = ordersNoLines.reduce((a,o)=>a+Number(o.total),0);
console.log(`GMV of orders WITH lines:   $${money(gmvWith)}`);
console.log(`GMV of orders WITHOUT lines: $${money(gmvWithout)}  ← this is the seed/test bulk`);

// sample the line-bearing (real-ish) orders
console.log(`\nsample of line-bearing orders:`);
ordersWithLines.slice(0,8).forEach(o => {
  console.log(`  ${o.id}  ${o.status.padEnd(11)} ${o.payment_method.padEnd(8)} total=$${money(o.total)}  lines=$${money(sumByOrder[o.id])}  ${o.created_at.slice(0,10)}`);
});

// ── 3. Real-looking order recency & velocity ──
console.log('\n══ REAL ORDER VELOCITY (orders WITH normalized lines) ══');
const active = ordersWithLines.filter(o => o.status !== 'deleted');
const last7 = active.filter(o => (now - Date.parse(o.created_at)) < 7*86400000).length;
const last30= active.filter(o => (now - Date.parse(o.created_at)) < 30*86400000).length;
const bySt = {};
active.forEach(o=>bySt[o.status]=(bySt[o.status]||0)+1);
console.log(`real(ish) orders: ${active.length}`);
console.log(`  by status: ${JSON.stringify(bySt)}`);
console.log(`  last 7d: ${last7}   last 30d: ${last30}`);
if (active.length) {
  const ts = active.map(o=>Date.parse(o.created_at)).sort();
  console.log(`  range: ${new Date(ts[0]).toISOString().slice(0,10)} → ${new Date(ts[ts.length-1]).toISOString().slice(0,10)}`);
}

// ── 4. Are seeded orders tied to session_id (POS) or guest? ──
console.log('\n══ ORDER ORIGIN ══');
const noLines = ordersNoLines;
const posSess = noLines.filter(o=>o.session_id).length;
const cashier = noLines.filter(o=>o.cashier_id).length;
const guest   = noLines.filter(o=>!o.user_id).length;
console.log(`no-line orders via POS session: ${posSess}`);
console.log(`no-line orders w/ cashier:      ${cashier}`);
console.log(`no-line orders w/o user_id:     ${guest} (guest/seed)`);

// ── 5. Monetization reality check ──
console.log('\n══ MONETIZATION ══');
console.log(`subscription_events: ${subs.length} total`);
subs.slice(0,10).forEach(e=>console.log(`  ${e.kind} $${money(e.amount)} ${e.plan||''} ${e.method||''} ${e.created_at.slice(0,10)}`));
// 3% of online-paid REAL (line-bearing) orders
const realOnline = active.filter(o => ['sifalo','waafi','evc','edahab'].includes((o.payment_method||'').toLowerCase()));
const realOnlineGmv = realOnline.reduce((a,o)=>a+Number(o.total),0);
console.log(`\nonline-paid REAL orders: ${realOnline.length}, GMV $${money(realOnlineGmv)}, implied 3% fee $${money(realOnlineGmv*0.03)}`);

// ── 6. Catalog reality ┐
console.log('\n══ CATALOG ══');
console.log(`products: ${prods.length}   business_products (claimed): ${bizp.length}`);
console.log(`product names: ${prods.map(p=>`${p.name} ($${money(p.price)}, stock ${p.stock})`).join(' | ')}`);

console.log('\nDone.');
