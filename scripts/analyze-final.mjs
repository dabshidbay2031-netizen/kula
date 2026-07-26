// Final probe: tie the $224k no-line orders to sellers, inspect the 8 real
// orders' actual items, and confirm catalog/seller linkage.
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
const envFile = fs.readFileSync(path.resolve('.env.local'),'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m&&m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const money=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2});

const {data:sellers}=await supa.from('suppliers').select('*');
const {data:orders}=await supa.from('orders').select('*');
const {data:ois}=await supa.from('order_items').select('*');
const {data:prods}=await supa.from('products').select('*');

// The 8 real orders: what items?
console.log('══ THE 8 LINE-BEARING ORDERS — FULL DETAIL ══');
const lineByOrder={};
ois.forEach(oi=>{(lineByOrder[oi.order_id]=lineByOrder[oi.order_id]||[]);lineByOrder[oi.order_id].push(oi);});
for(const o of orders.filter(o=>lineByOrder[o.id])){
  console.log(`\n${o.id}  status=${o.status}  pay=${o.payment_method}  total=$${money(o.total)}  cust="${o.customer_name}"/"${o.customer_phone}"  ${o.created_at.slice(0,10)}`);
  for(const oi of lineByOrder[o.id]){
    const p=prods.find(p=>p.id===oi.product_id);
    console.log(`    → ${p?p.name:'product #'+oi.product_id}  qty ${oi.qty} @ $${money(oi.unit_price)} = $${money(oi.line_total)}  (supplier ${oi.supplier_id})`);
  }
}

// The $224k no-line orders: which sellers' products? Inspect the items JSONB.
console.log('\n\n══ THE $224K SEED ORDERS — items JSONB sample ══');
const noLine = orders.filter(o=>!lineByOrder[o.id] && o.status!=='deleted');
console.log(`count: ${noLine.length}, GMV: $${money(noLine.reduce((a,o)=>a+Number(o.total),0))}`);
// sample totals distribution
const big = noLine.filter(o=>Number(o.total)>1000).length;
console.log(`orders over $1000: ${big}`);
console.log(`sample items JSONB (first 3):`);
noLine.slice(0,3).forEach(o=>{
  console.log(`  ${o.id} total=$${money(o.total)} pay=${o.payment_method} items=${JSON.stringify(o.items).slice(0,140)}`);
});

// Are the no-line orders tied to a session/cashier/seller at all?
console.log('\n══ DO SEED ORDERS REFLECT REAL SELLER ACTIVITY? ══');
const withSess = noLine.filter(o=>o.session_id).length;
const withCashier = noLine.filter(o=>o.cashier_id).length;
console.log(`no-line orders w/ POS session_id: ${withSess}`);
console.log(`no-line orders w/ cashier_id:     ${withCashier}`);
// group totals by customer_phone to see spread
const byPhone={};
noLine.forEach(o=>{byPhone[o.customer_phone]=(byPhone[o.customer_phone]||{c:0,t:0});byPhone[o.customer_phone].c++;byPhone[o.customer_phone].t+=Number(o.total);});
const topPhones=Object.entries(byPhone).sort((a,b)=>b[1].t-a[1].t).slice(0,6);
console.log(`top customer phones by spend:`);
topPhones.forEach(([ph,d])=>console.log(`  "${ph}": ${d.c} orders, $${money(d.t)}`));

// sellers and their subscription_paid_at vs created_at (are grandfathered or real-paid?)
console.log('\n══ SELLER SUBSCRIPTION: grandfathered vs genuinely paid? ══');
sellers.forEach(s=>{
  if(s.subscription_paid_at){
    const created=Date.parse(s.created_at), paid=Date.parse(s.subscription_paid_at);
    const diffH=Math.round((paid-created)/3600000);
    const flag = diffH < 24 ? `(paid ${diffH}h after create)` : '(grandfathered/backfilled)';
    console.log(`  ${s.name.padEnd(22)} ${s.account_type.padEnd(9)} created ${s.created_at.slice(0,10)} paid ${s.subscription_paid_at.slice(0,10)} ${flag}`);
  }
});
