# Hamar Mall — Complete Audit Report

Every finding from the dashboard, orders, and chat review. For each one you get:
- **🔴 Severity** — how bad it is
- **💻 Technical** — the exact code and why it's broken (file + line)
- **🗣️ Plain English** — what it means with a real-world analogy
- **✅ The Fix** — what to do, concretely

---

# PART 1 — SECURITY HOLES (fix first)

These are the doors with no locks. They expose your customers' private data and your sellers' secret prices.

---

## 🔴 S1. Chat conversations list has NO authentication

**💻 Technical — `app/api/conversations/route.ts:21-24`**
```ts
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
  // ← NO getAuthUser(), NO JWT check. The code then runs:
  //   .or(`user_id_1.eq.${userId},user_id_2.eq.${userId}`)
  // ...and returns every conversation + last message + unread count for that UID.
```
The handler trusts the `userId` in the URL query string completely. There is no check that the person making the request is actually logged in as that user. Compare to the sibling endpoint `app/api/conversations/[id]/messages/route.ts:13-24` which DOES call `getAuthUser(req)` and verify membership — that's the correct pattern, it was just never copied here.

**🗣️ Plain English**
Imagine a bank where the teller hands over anyone's account statement if you simply walk in and say "I'm Ahmed, show me my statements" — no ID check. Right now, anyone who knows or guesses a user's ID number can pull up that user's **entire chat list**: everyone they talk to, a preview of the last message in each chat, and how many unread messages they have. Your customers' private conversations are an open book to strangers.

**✅ The Fix**
Require authentication, and make sure the logged-in user matches the requested `userId`:
```ts
import { getAuthUser } from '@/lib/apiAuth';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!userId || userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // ...rest unchanged...
}
```
Three lines added. The correct helper already exists in your codebase.

---

## 🔴 S2. Single conversation detail has NO membership check

**💻 Technical — `app/api/conversations/[id]/route.ts:14-24`**
```ts
const viewerId = searchParams.get('viewerId') ?? '';
// ...
const { data, error } = await getSupabaseAdmin()
  .from('conversations').select('*').eq('id', (await params).id).single();
// returns data with NO check that viewerId is one of the two participants
```
`viewerId` is read from the URL and used only to decide which profile to label "the other person" — it is never validated against a real login, and never checked against `user_id_1`/`user_id_2`. The response includes both participants' resolved profiles via `resolveChatUser()` (`lib/chatHelpers.ts`), which for businesses returns `contact_numbers`.

**🗣️ Plain English**
Think of every chat conversation as a private letter between two people. Right now, anyone who knows the letter's tracking number can open it and read both people's full details — names, photos, and for businesses, their private phone numbers. It's like the post office letting anyone read your mail if they quote the parcel number.

**✅ The Fix**
Reuse the same `requireParticipant` pattern from the messages route:
```ts
import { getAuthUser } from '@/lib/apiAuth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const convId = (await params).id;
  const { data } = await getSupabaseAdmin()
    .from('conversations').select('user_id_1, user_id_2').eq('id', convId).maybeSingle();
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const members = [String(data.user_id_1), String(data.user_id_2)];
  if (!members.includes(user.id)) {
    return NextResponse.json({ error: 'Forbidden — not a participant' }, { status: 403 });
  }
  // ...rest unchanged, using user.id as viewerId...
}
```

---

## 🔴 S3. Creating a conversation has NO authentication

**💻 Technical — `app/api/conversations/route.ts:85-92`**
```ts
export async function POST(req: Request) {
  const { userId1, userId2 } = await req.json();
  if (!userId1 || !userId2) return ...400;
  if (userId1 === userId2) return ...400;
  // ← no auth, no check that the caller is userId1 or userId2
```
Anyone can POST any two user IDs and a conversation row is created between them. The only validation is "they're not the same person."

**🗣️ Plain English**
Picture a postal service where anyone can walk in and say "open a mailbox between Ahmed and Fatima" — and the system just does it, no questions. An attacker can quietly open a chat channel with a victim before the victim has agreed to anything, so the victim's first sight of their inbox is the attacker already there. Combined with S1/S2, it's the setup for harassment.

**✅ The Fix**
Require login and confirm the caller is one of the two participants:
```ts
import { getAuthUser } from '@/lib/apiAuth';

export async function POST(req: Request) {
  const { userId1, userId2 } = await req.json();
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!userId1 || !userId2) return ...400;
  // The caller must be one of the two people in the conversation:
  if (user.id !== userId1 && user.id !== userId2) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // ...rest unchanged...
}
```

---

## 🔴 S4. The chat photo storage has no access rules

**💻 Technical — `supabase/schema_v3.sql:738-752`**
```sql
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-images', 'chat-images', true)
  ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 10485760, allowed_mime_types = ...;

CREATE POLICY "chat_images_upload" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'chat-images');   -- ← no auth.role() check, no owner check
```
The bucket is `public = true` (anyone with a URL can view), and the upload policy has no `auth.role() = 'authenticated'` clause and no `(owner) = auth.uid()` path check. So: anonymous uploads allowed, and every private chat photo is world-readable by URL.

**🗣️ Plain English**
Your chat photos are stored in a box that's labelled "public" and has no rule about who can drop things in. So two problems: anyone walking by can put junk in your box, and anyone can take out and view photos that were meant to be private between two people. A customer sending a private photo to a seller has no idea it's actually viewable by the whole internet.

**✅ The Fix**
Two SQL policies (run in Supabase SQL editor):
```sql
-- Only logged-in users can upload, and only into their own folder:
DROP POLICY IF EXISTS "chat_images_upload" ON storage.objects;
CREATE POLICY "chat_images_upload" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'chat-images' AND (owner) = auth.uid());

-- (Optional) make photos viewable only by the two chat participants:
-- This requires storing participant info; simplest first step is to switch
-- the bucket to private and serve signed URLs from the API route instead
-- of embedding public Storage URLs in messages.
```
Then change the chat so image URLs are generated as **signed** (time-limited) URLs server-side, not public URLs.

---

## 🔴 S5. A competitor can read every store's cost prices

**💻 Technical — `app/api/business-products/route.ts:67-89`**
The GET handler reads `supplierId` from the query and returns the rows with no auth. The response includes `cost`, `customPrice`, `stockQty` and the nested `products(*)`. `BusinessDashboardView.tsx:70` calls it with no `authHeaders()`. Compare to `/api/orders` which calls `requireSupplierAccess(req, supplierId)` (`orders/route.ts:133`).

**🗣️ Plain English**
Every shop owner has a secret: what they actually pay for their goods (their "cost price"). It's the most sensitive number in retail — it tells you their profit margin and how low they could drop their price. Right now, any rival can ask your website "show me store #5's products" and get back exactly what store #5 paid for each item, what they charge, and how much stock they hold. It's like a competitor being able to walk into your back office and read your supplier invoices.

**✅ The Fix**
Add the same ownership check that `/api/orders` already uses:
```ts
import { requireSupplierAccess } from '@/lib/apiAuth';

export async function GET(req: Request) {
  const supplierId = Number(new URL(req.url).searchParams.get('supplierId'));
  const guard = await requireSupplierAccess(req, supplierId, 'inventory');
  if (guard) return guard;  // 403 if not owner/admin/staff
  // ...rest unchanged...
}
```
And update `BusinessDashboardView.tsx:70` to send `await authHeaders()` with the fetch.

---

## 🟠 S6. Messaging has no speed limit (spam/harassment)

**💻 Technical — `lib/rateLimit.ts`** exists and is applied to AI, login, orders, and payments, but **never imported by any `app/api/conversations/*` route.** There is also no block/mute/report feature anywhere in the chat code.

**🗣️ Plain English**
Your system already has a "speed camera" — it stops people from hammering the login or payment buttons. But nobody put a speed camera on the messaging road. So one person can send thousands of messages per minute to flood someone's inbox, and the victim has no "block this person" button to make it stop. On a marketplace, one harasser can drive away dozens of customers, and you'd have no tool to stop them.

**✅ The Fix**
1. Add the existing rate limiter to the message-send route:
```ts
import { rateLimit } from '@/lib/rateLimit';

export async function POST(...) {
  const auth = await requireParticipant(req, convId);
  if (auth instanceof Response) return auth;
  // e.g. max 30 messages per 10 seconds per user:
  const limited = await rateLimit(`chat-msg:${auth}`, 30, 10_000);
  if (limited) return NextResponse.json({ error: 'Slow down' }, { status: 429 });
  // ...rest...
}
```
2. Build a simple block: a `blocked_users` table `(blocker_uid, blocked_uid)`; check it in `requireParticipant` and refuse send + hide the conversation.

---

# PART 2 — MONEY & DATA INTEGRITY (your numbers must be honest)

---

## 🟠 M1. Two customers can buy the last item at the same time

**💻 Technical — `app/api/orders/route.ts:386, 484-493`**
The atomic `place_order()` SQL function uses `SELECT ... FOR UPDATE` + `WHERE id = v_pid AND stock >= v_qty` (safe). But it is **skipped** at line 288 when `isBulk || staffDiscount > 0 || hasTieredItem`. The fallback JS path reads stock (line 367), checks it (line 386), then later updates with:
```ts
.update({
  stock: Math.max((p.stock as number) - item.qty, 0),  // ← p.stock is the stale snapshot
  sold:  ((p.sold as number) ?? 0) + item.qty,
})
.eq('id', item.id);   // ← no .gte('stock', item.qty) guard
```
No row lock, no conditional update. Two concurrent buyers both read `stock=1`, both pass the check, both write `stock=0` → 2 sold, 1 stock. The order is also inserted (line 477) before stock moves (line 484), so a crash between them leaves a paid order with no stock change.

**🗣️ Plain English**
Imagine one apple left on the shelf. Two customers reach for it at the exact same split second. A good cashier locks the shelf for a moment so only one hand gets it. Your system, for the most common types of sale, doesn't lock the shelf — it glances, sees the apple, says "yes" to both customers, and promises the same apple to two people. You've now sold stock you don't have. The good news: you already built the "locking cashier" version (`place_order`) — you just need to use it for these cases too.

**✅ The Fix**
Two options, best first:
- **Best:** extend `place_order()` to accept tiered/bulk pricing and staff discounts, so the atomic path handles every order.
- **Quick:** make the fallback's stock update conditional so it can't go negative:
```ts
await sb.from('products')
  .update({ stock: Math.max((p.stock as number) - item.qty, 0),
            sold:  ((p.sold as number) ?? 0) + item.qty })
  .eq('id', item.id)
  .gte('stock', item.qty);   // ← only decrements if still enough stock
```
Also reorder so stock moves **inside the same operation** as the order insert, or wrap both in the RPC.

---

## 🟠 M2. The clean sales record is empty for most orders

**💻 Technical — `place_order()` writes `order_items` (`schema_v3.sql:599-600`), but it's the ONLY writer.** The JS fallback (`route.ts:429-437`) builds a `pricedItems` array and stores it only in `orders.items` (JSONB), never inserting into `order_items`. So bulk / tiered / staff-discount / RPC-unavailable orders have no normalized lines. (This is why only 8/491 orders had `order_items` rows.)

**🗣️ Plain English**
Every sale should produce a clean, itemized receipt: "2 × Laptops @ $320, sold by Store #5." Your system writes that clean receipt for only some sales — the rest only get a messy shorthand note stuffed in a drawer. So when you ask "how much did Store #5 earn?" or "what are our top sellers?", the answer is wrong, because half the receipts are missing from the neat pile. Reports and payouts are silently undercounted.

**✅ The Fix**
In the JS fallback, after the order insert, write the same lines into `order_items` (the data is already computed):
```ts
// after the order is inserted and orderId is known:
if (pricedItems.length) {
  await sb.from('order_items').insert(
    pricedItems.map(p => ({
      order_id:    orderId,
      product_id:  p.id,
      supplier_id: p.supplierId ?? null,
      qty:         p.qty,
      unit_price:  p.unitPrice,
      line_total:  round2(p.unitPrice * p.qty),
    }))
  );
}
```

---

## 🟡 M3. The dashboard's revenue number disagrees with the wallet

**💻 Technical — `views/BusinessDashboardView.tsx:120-132`**
```ts
const orderRevenue = (o) => o.items.reduce((sum, it) => {
  if (!myProductIds.has(it.id)) return sum;
  return sum + (prodById.get(it.id)?.price ?? 0) * it.qty;   // ← CURRENT catalog price
}, 0);
const orderProfit  = (o) => o.items.reduce((sum, it) => {
  if (!myProductIds.has(it.id)) return sum;
  const p = prodById.get(it.id);
  return sum + ((p?.price ?? 0) - (p?.cost ?? 0)) * it.qty;  // ← current price & cost
}, 0);
```
Uses current catalog price/cost, not the snapshotted line-item price. Also doesn't subtract `fee_paid_by_store`. The wallet (`app/api/payouts/route.ts:67-80`) deliberately fixed this; the dashboard didn't.

**🗣️ Plain English**
When a seller looks at their dashboard, "Revenue" is calculated using **today's price**, not the price the customer actually paid on the day. So if they raise their price tomorrow, last week's sales magically look bigger — fake growth. Worse, the dashboard doesn't subtract your 3% fee. So the number a seller sees on their dashboard **will not match the money in their wallet.** A seller who sees "$1,000 revenue" but only "$900 in the wallet" will accuse you of skimming.

**✅ The Fix**
Use the price recorded on the order line item (the snapshot at sale time), and subtract any fee the store absorbed:
```ts
// prefer the snapshot price stored on the order line; fall back to catalog only if missing
const unit = it.unitPrice ?? it.price ?? prodById.get(it.id)?.price ?? 0;
const lineRev = unit * it.qty;
const lineProfit = (unit - (it.cost ?? prodById.get(it.id)?.cost ?? 0)) * it.qty;
// subtract the fee the store chose to absorb:
const storeFee = o.feePaidByStore ?? 0;
// revenue includes storeFee deduction when computing "net to store"
```
Then the dashboard and wallet will agree. Add a separate "Platform fee (3%)" line so it's visible.

---

## 🟡 M4. A customer could mark their own order "completed"

**💻 Technical — `app/api/orders/route.ts:219-221`**
```ts
const requestedStatus = typeof body.status === 'string' && VALID_STATUS.has(body.status)
  ? body.status
  : (isBulk ? 'bulk_pending' : 'pending');
```
The client can send `status: 'completed'` and it's honored with no check that the caller is staff/seller. `CheckoutView` doesn't send it, but a direct API call can.

**🗣️ Plain English**
There's a hidden gap: if someone knows how to talk to your website directly (not through your buttons), they could create an order that's already marked "finished" — skipping the whole delivery and payment process. It's like a customer walking out of the shop and stamping their own receipt "PAID" without paying. Your checkout buttons don't allow it, but the back door isn't guarded.

**✅ The Fix**
Only allow `completed` from a verified seller/staff token:
```ts
let requestedStatus = isBulk ? 'bulk_pending' : 'pending';
if (typeof body.status === 'string' && VALID_STATUS.has(body.status)) {
  // 'completed'/'processing' etc. are seller-only — require staff/seller auth:
  if (body.status !== 'pending' && body.status !== 'bulk_pending') {
    const staff = await getStaffOrSeller(req);  // your existing staff check
    if (!staff) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  requestedStatus = body.status;
}
```

---

## 🟡 M5. Double-click creates duplicate orders

**💻 Technical — `app/api/orders/route.ts`** has no idempotency key. `CheckoutView.tsx:248` disables the button client-side, but that's not server-enforced. Sifalo `ref` is regenerated each click (`CheckoutView.tsx:261`), so the payment gateway won't dedup either.

**🗣️ Plain English**
If a customer's finger slips and they double-click "Place Order," or their internet blips and they tap it again, **two identical orders are created** and they might be charged twice. Nothing in the system notices "hey, I just did this exact thing a second ago." Real customers do this constantly on mobile.

**✅ The Fix**
Generate a one-time idempotency key when the checkout screen opens, send it with the order, and reject duplicates server-side:
```ts
// client: const idempotencyKey = crypto.randomUUID();  // once per checkout
// server POST:
const key = headersList.get('Idempotency-Key');
if (key) {
  const { data: existing } = await sb.from('orders')
    .select('id').eq('idempotency_key', key).maybeSingle();
  if (existing) return NextResponse.json({ id: existing.id, duplicate: true });
}
```
(Add an `idempotency_key TEXT UNIQUE` column to `orders`.)

---

## 🟡 M6. Order status can be set to nonsense strings

**💻 Technical — `app/api/orders/[id]/route.ts:207-213` + `forwardOnlyViolation:195`**
`forwardOnlyViolation` returns `null` (no violation) for unknown labels:
```ts
if (from === undefined || to === undefined) return null; // unknown label — don't block
```
So `PATCH { status: "h4ck3d" }` is accepted; the DB CHECK constraint later rejects it with an ugly 500 instead of a clean 400.

**🗣️ Plain English**
Your system keeps a tidy list of order stages ("pending", "shipped", "completed"). But the update form doesn't check that a new stage is actually on that list — it just accepts whatever word is sent. If someone sends a nonsense stage, the database eventually blocks it, but with a confusing error instead of a polite "that's not a valid status."

**✅ The Fix**
Validate against the whitelist first:
```ts
const VALID_STATUS = new Set(['pending','processing','shipped','completed','cancelled','refunded','bulk_pending']);
if (body.status !== undefined && !VALID_STATUS.has(String(body.status))) {
  return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
}
```

---

## 🟡 M7. Payment method accepts any text

**💻 Technical — `app/api/orders/route.ts:217`**
```ts
const paymentMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod : 'cash';
```
No whitelist; the DB has no CHECK on `orders.payment_method`. Unknown methods are treated as fee-free cash.

**🗣️ Plain English**
"Payment method" should only ever be one of your real options (cash, EVC Plus, ZAAD, Sifalo, etc.). Right now the system accepts any made-up word. If someone types "freemoney" as the payment method, the system just shrugs and records it — and since it doesn't recognize "freemoney" as an online payment, it skips your 3% fee entirely.

**✅ The Fix**
Whitelist it, and add a DB CHECK:
```ts
const VALID_METHODS = new Set(['cash','sifalo','waafi','evc','edahab','card','invoice']);
if (!VALID_METHODS.has(paymentMethod)) paymentMethod = 'cash';
```
```sql
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN ('cash','sifalo','waafi','evc','edahab','card','invoice'));
```

---

# PART 3 — CUSTOMER EXPERIENCE BUGS

---

## 🔴 C1. Messages can silently disappear (data loss)

**💻 Technical — `views/ChatRoomView.tsx:225-237`**
```ts
if (res.ok) {
  const saved = await res.json();
  setMessages(prev => prev.map(m => m.id === tempId ? saved : m));
}
// ← no else branch: a 4xx/5xx is silently ignored
```
On failure the optimistic temp message stays rendered with a `✓` (looks sent). No retry, no failed indicator, no offline queue.

**🗣️ Plain English**
If sending a message fails (bad signal, server hiccup), the message **stays on the screen looking successfully sent** — but it never arrived. The customer thinks they replied to the seller; the seller never got it. The customer then assumes the seller is ignoring them and goes elsewhere. **This silently loses you sales**, and neither side ever knows why.

**✅ The Fix**
Show a failed state and offer retry:
```ts
if (!res.ok) {
  setMessages(prev => prev.map(m => m.id === tempId ? { ...m, failed: true } : m));
  return;
}
```
Render a "⚠ Tap to retry" on `failed` messages, and on tap, re-send. Optionally queue to IndexedDB so an unsent message survives a reload.

---

## 🟡 C2. Read receipts (blue ticks) don't actually update

**💻 Technical — `views/ChatRoomView.tsx:160-168`** subscribes only to `event: 'INSERT'` on messages, not `UPDATE`. So when the recipient reads a message and `read_at` is PATCHed, the sender's screen never receives the update — the `✓` never becomes `✓✓` without a reload.

**🗣️ Plain English**
Your chat shows ticks to mean "delivered" and "read." But the part that flips the tick to "read" is broken — the sender's screen is frozen at "delivered" forever unless they close and reopen the chat. So sellers sit there thinking "the customer hasn't read my reply," when actually they have. It breeds unnecessary frustration on both sides.

**✅ The Fix**
Also subscribe to UPDATE events and patch the local message:
```ts
.on('postgres_changes',
  { event: 'UPDATE', schema: 'public', table: 'messages',
    filter: `conversation_id=eq.${convId}` },
  (payload) => {
    setMessages(prev => prev.map(m =>
      m.id === payload.new.id ? { ...m, readAt: payload.new.read_at } : m));
  })
```

---

## 🟡 C3. Old chat history can't be scrolled back

**💻 Technical — `views/ChatRoomView.tsx:129`** calls `?limit=50` once and never uses the `before` cursor. The server supports pagination (`messages/route.ts:51-65`), but the client never asks for older messages.

**🗣️ Plain English**
Your chat only ever shows the **most recent 50 messages.** Anything older simply isn't there. If a customer and a seller have a long conversation about an order, after a while the beginning of it just… vanishes. The system is capable of loading more, but the chat screen never bothers to ask.

**✅ The Fix**
Add a "load older" button (or scroll-to-top trigger) that fetches with `before=<oldest message timestamp>` and prepends. The server already supports it.

---

## 🟡 C4. The filter buttons in admin destroy data

**💻 Technical — `components/AdminDashboard.tsx:839, 910`**
```ts
setOrders(prev => prev.filter(o => (o.status ?? '') === v));
setUsers(prev => prev.filter(u => u.fullName?.includes(q)));
```
This mutates the source state. Compare to the correct pattern at `:155-175` (`filteredProducts` = derived view without mutating). Filtering is irreversible until a full refetch.

**🗣️ Plain English**
When you filter orders or users in your admin panel (say, "show only completed orders"), the system **actually deletes the other orders from memory** instead of just hiding them. So when you switch the filter back to "all," the list is wrong until the page fully reloads. It's like a filing cabinet that shreds every folder you're not currently looking at.

**✅ The Fix**
Keep the full list as the source of truth and compute the filtered view from it (the way `filteredProducts` already does):
```ts
const [orders, setOrders] = useState([]);           // full list — never mutate to filter
const [statusFilter, setStatusFilter] = useState('');
const visibleOrders = statusFilter
  ? orders.filter(o => (o.status ?? '') === statusFilter)
  : orders;
// onChange just sets statusFilter — never setOrders(filter(...))
```

---

## 🟡 C5. Errors get hidden behind a smile

**💻 Technical — `app/api/orders/route.ts:148-150, 176-178`**
```ts
catch { return NextResponse.json([]); }   // server error → returns [] with HTTP 200
```
The dashboard then shows "No sales in this period" instead of an error. Same pattern in `AdminDashboard.tsx:226` (`catch { /* ignore */ }` → infinite spinner).

**🗣️ Plain English**
When the system fails to fetch your orders, instead of telling you "something broke," it returns an empty list and a success code. So your dashboard cheerfully says "no sales today!" when the truth is **the system crashed** and there might be plenty of sales — you just can't see them. You'd never know there was a problem until a customer complained.

**✅ The Fix**
Return a real error status and handle it:
```ts
catch (e) {
  return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
}
// dashboard: if (!res.ok) setError(true);
```

---

# PART 4 — PERFORMANCE (matters as you grow)

---

## 🟢 P1. The chat inbox fires a storm of requests

**💻 Technical — `app/api/conversations/route.ts:36-71`** does 2 queries × conversation server-side, then `ChatListView.tsx:63-71` does N more client-side fetches — **3N+1 requests per inbox load**, re-fired on every realtime ping with no debounce.

**🗣️ Plain English**
Every time someone opens their inbox, your system fires off a separate request for *every single conversation* — "give me the last message," "how many unread," "who's the other person." If someone has 100 conversations, that's 300+ little requests just to show the inbox. It's like a receptionist making 300 separate phone calls to assemble one list that should be a single printed page.

**✅ The Fix**
One server-side query that joins conversations + last message + counter + other-user profile, and embed the profile in the original response so the client doesn't re-fetch. Use a SQL view or a LATERAL join.

---

## 🟢 P2. Revenue is computed by downloading the whole table

**💻 Technical — `app/api/admin/stats/route.ts:62-75`** `select('total, status')` over ALL orders into the Node process, then a JS `.reduce()`. Should be a SQL `SUM`.

**🗣️ Plain English**
To show you the total revenue, your system currently downloads **every single order ever placed** into memory and then adds them up by hand. When you have a few hundred orders that's fine. When you have 100,000 orders, that's slow and heavy. It's like printing out your entire bank history onto paper and counting it with a calculator, instead of just reading the "balance" number the bank already computed.

**✅ The Fix**
Let the database do the math:
```ts
const { data } = await getSupabaseAdmin()
  .from('orders')
  .select('status')
  .in('status', ['pending','processing','shipped','completed'])
  .sum('total');   // or an RPC/SUM aggregate
```

---

## 🟢 P3. The wallet truncates at 1000 orders

**💻 Technical — `app/api/payouts/route.ts:96`** `.limit(1000)` on the earnings query, but sums all payouts (no limit) → balance goes inconsistent at scale.

**🗣️ Plain English**
When calculating how much money a seller can withdraw, the system only looks at their **most recent 1000 orders** of earnings — but it counts **all** their withdrawals. So once a seller has been around long enough to have more than 1000 orders, their balance silently ignores older earnings while still subtracting older payouts. The number drifts wrong. At your current size this doesn't matter, but it's a ticking bomb.

**✅ The Fix**
Remove the limit and compute earnings as a SQL aggregate, or paginate the full history. Never mix a capped sum with an uncapped sum.

---

## 🟡 P4. Real orders are capped at 500 visible

**💻 Technical — `app/api/orders/route.ts:141-147`** `.limit(500)`, no pagination.

**🗣️ Plain English**
When a store owner opens their orders, they only ever see the **most recent 500.** Older orders are there in the database but invisible. A busy long-running store loses access to its own history.

**✅ The Fix**
Add server-side pagination (offset/cursor + page size) and an infinite-scroll or "load more" button in the UI.

---

# PART 5 — THE BUSINESS REALITY (from your live data)

This isn't a code bug — it's what your actual data showed. You need to know it.

---

## 📊 B1. 98% of your "orders" are fake test data

**💻 Technical** — 484 "active" orders in the DB, but only 8 have `order_items` rows (real orders). The other 476 are from a June seed script — no line items, $224k fake GMV, 54 of them have empty customer phone numbers. Seed pattern matches names like "Test Business Store," "the business."

**🗣️ Plain English**
If you looked at your dashboard today and saw "$225,000 in sales" — **$224,000 of that is fictional.** It's sample data someone loaded in June to test the system. The real number, from real customers, is about **$966**, all from the last 2 days, and it's people testing (six $1 items, three $320 laptops from one name). Your dashboard is lying to you right now because it can't tell the difference.

**✅ The Fix**
Tag or purge the seed data. Add an `is_seed BOOLEAN DEFAULT false` column, mark all the June seed orders `is_seed = true`, and exclude them from every report/KPI. Then your numbers finally reflect reality. (Or move them to a separate dataset.)

---

## 📊 B2. The shop shelves are empty

**💻 Technical** — `products` table has 3 rows (1 HP Laptop, 2 "qalimo"); `business_products` has 0 rows; 23 of 31 sellers have zero listings.

**🗣️ Plain English**
A marketplace with nothing to buy is dead. You have 31 sellers but only 3 products total, and **not one seller has actually stocked their shop.** Even your real signups (Boomaal Electronics, teknofault, Samiira Soomaali) have empty stores. Sellers who sign up and see a blank shelf don't come back.

**✅ The Fix**
Seed real inventory. Add 15–30 genuine products across the categories you advertise (electronics, food, clothing, medicine). Then personally walk each real seller through listing their first 5 products. The platform can't sell what isn't there.

---

## 📊 B3. No real order has ever completed

**💻 Technical** — all 8 real orders are `status = pending`. Zero have reached `completed`. 166 orders (mostly seed) are stuck >3 days in pending/processing.

**🗣️ Plain English**
The buying journey has never once gone all the way to the end for a real customer. Orders get placed and then just… sit. Nobody has tested whether a customer can actually receive what they ordered, because no order has ever moved past "pending." Your core loop is unproven.

**✅ The Fix**
Yourself, place one real order and walk it manually through every stage — pending → processing → shipped → completed. Note every broken thing. Fix them. **Do not launch marketing until one genuine transaction goes end-to-end.**

---

## 📊 B4. You've collected $0 in real revenue

**💻 Technical** — `subscription_events` table is empty (0 rows). The "paid_at" on 17 sellers equals their `created_at` (the grandfathering backfill from `migration_subscriptions.sql:23-31`), not real payments.

**🗣️ Plain English**
Your dashboard shows sellers as "paid," but that's the system lying again — it auto-marked everyone as paid on signup so they wouldn't get locked out. **Nobody has actually paid you a subscription fee.** Your real payment ledger is empty. When the grace period ends, every seller could be locked out with no proven way to pay.

**✅ The Fix**
Reconcile `subscription_paid_at` with `subscription_events`. Either collect real payments now (walk one seller through paying), or deliberately extend the grace window — but don't leave it accidental. Prove the billing flow with one real $14.99 payment.

---

## 📊 B5. Almost no sellers are verified

**💻 Technical** — `suppliers.verified`: 1 of 31 true. GPS location: 2 of 31. Contact number: 1 of 31.

**🗣️ Plain English**
Your big trust feature is the green ✓ that says "this store is real." But **only 1 of 31 stores has it.** Almost none have a location or phone number. So your "Verified stores" promise is mostly empty, your map feature has almost nothing to show, and buyers can't call sellers. Trust is the currency of a marketplace, and right now you have almost none in the bank.

**✅ The Fix**
Verify your real sellers yourself — contact them, confirm they're genuine, tick the ✓. Get at least the top 10 stores a phone number and a map pin. Make store setup require (or strongly prompt for) contact + location.

---

# THE MASTER PRIORITY LIST

Do them in this order. Each one is small; together they transform the business.

### 🔴 Week 1 — Close the security holes
1. **S1, S2, S3** — Add authentication to the 3 chat endpoints (copy `requireParticipant` — it already exists in your code)
2. **S4** — Add access rules to the chat photo storage
3. **S5** — Lock the business-products endpoint so competitors can't read cost prices
4. **S6** — Add a speed limit + block button to messaging

### 🟠 Month 1 — Make the money honest
5. **M1** — Stop the double-buy race (use the atomic `place_order` for all sales)
6. **M2** — Write the clean sales record for every order
7. **M3** — Fix the dashboard so it matches the wallet
8. **M4, M5, M6, M7** — Close the order-status / payment-method / duplicate-order gaps

### 🟡 Month 2 — Fix the customer experience
9. **C1** — Never silently drop a message (show "failed, tap to retry")
10. **C2** — Fix read receipts
11. **C3** — Allow scrolling back through chat history
12. **C4, C5** — Stop the admin filters destroying data; show real errors

### 🟢 As you grow — Performance
13. **P1, P2, P3, P4** — Move aggregations to SQL, paginate, fix the wallet truncation

### 🧹 Now — Make your numbers trustworthy
14. **B1** — Tag or purge the fake seed data
15. **B2** — Stock the shelves with real products
16. **B3** — Walk one real order all the way to completed
17. **B4** — Prove the billing flow with one real payment
18. **B5** — Verify your real sellers

---

## The one-paragraph truth

You've built a genuinely impressive, sophisticated platform. The bones are strong — server-side pricing, atomic order logic, ownership checks, realtime. But three things are true at once: **(1) your customers' private messages and photos are currently readable by strangers, and competitors can see your sellers' cost prices — fix the locks this week; (2) your dashboard numbers don't add up to real money — make them honest; (3) the business itself hasn't started — empty shelves, no completed real orders, no real revenue.** Fix the security first (it's your reputation), make the numbers trustworthy second, then stock the shelves and walk one real sale through to the end. Do those things and you'll have a real, trustworthy business underneath the platform you've already built.

---

*This report is saved as `AUDIT-FULL-REPORT.md` in your project. Every finding includes the exact file and line so any developer can act on it immediately.*

**Want me to start fixing?** I'd begin with S1–S5 (the security locks) — they're small, surgical, and close the real danger. I'll show you exactly what I change before I touch anything. Just say the word.
