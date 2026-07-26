# Plan: Fix Part 1 (Security) — Chat Auth, Photo Bucket, Cost-Price Leak, Spam/Block

All 6 items from Part 1 of the audit. Every fix reuses patterns/helpers that **already exist** in the codebase — no new abstractions.

## S1, S2, S3 — Add authentication to the 3 open chat endpoints
Clone the existing `requireParticipant` pattern (already used in `messages/route.ts:13-24`) to the three endpoints that lack it.

**`app/api/conversations/route.ts`** (list + create):
- GET: add `getAuthUser(req)` → 401 if none; reject if `userId !== user.id` → 403. (3 lines)
- POST: add `getAuthUser(req)` → 401; reject unless `user.id === userId1 || user.id === userId2` → 403. (3 lines)

**`app/api/conversations/[id]/route.ts`** (single conversation):
- GET: add `getAuthUser(req)` → 401; fetch the conversation's `user_id_1, user_id_2`; reject unless caller is a member → 403. Reuses the exact membership check already in `requireParticipant`.

## S5 — Lock the business-products GET (cost-price leak)
**`app/api/business-products/route.ts`** GET handler: after the `supplierId` presence check, add `const denied = await requireSupplierAccess(req, parseInt(supplierId,10)); if (denied) return denied;` — identical to what POST already does (it returns `Response|null`).

**Two client callers must start sending auth headers** or they'll 403:
- `lib/useMyProductIds.ts:77` — add `{ headers: await authHeaders() }` + import.
- `components/AdminDashboard.tsx:127` — same. (Admins pass `requireSupplierAccess` via `canAccessStore`, so they work once the token is sent.)

## S4 — Lock chat photo uploads to authenticated owners
Per your choice (uploads only; bucket stays public-readable, no signed URLs). New **`supabase/migration_v4_4.sql`** (first migration to touch storage):
```sql
-- Only authenticated users, and only into their own {uid}/ folder:
DROP POLICY IF EXISTS "chat_images_upload" ON storage.objects;
CREATE POLICY "chat_images_upload" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'chat-images'
              AND (storage.foldername(name))[1] = auth.uid()::text);
```
The upload path is already `${user.id}/...` (`ChatRoomView.tsx:253`), so the owner-segment check maps directly. Public SELECT stays — existing image URLs keep working. This is **SQL you run in Supabase**; the file documents it.

## S6 — Rate limit + block-user feature
Per your choice (both). 

**Rate limit** on message send — `app/api/conversations/[id]/messages/route.ts` POST, ~4 lines, copying the canonical idiom from `app/api/ai/assistant/route.ts:16-18`:
```ts
const rl = rateLimit(`chat-msg:${clientIp(req)}`, 30, 10_000);
if (!rl.ok) return NextResponse.json({ error: 'Slow down' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } });
```

**Block-user feature** — three pieces:
1. **`supabase/migration_v4_4.sql`** — new table + RLS:
   ```sql
   CREATE TABLE IF NOT EXISTS blocked_users (
     blocker_uid TEXT NOT NULL,
     blocked_uid  TEXT NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (blocker_uid, blocked_uid)
   );
   ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "blocked_self" ON blocked_users FOR ALL
     TO authenticated USING (blocker_uid = auth.uid()) WITH CHECK (blocker_uid = auth.uid());
   ```
2. **`app/api/blocks/route.ts`** (new) — POST `{ blockedUid }` to block, DELETE to unblock, GET to list my blocks. Uses `getAuthUser(req)`; ~60 lines mirroring the conversation-route patterns.
3. **Block enforcement in the send path** — in `requireParticipant` (or just before the insert in messages POST): if either party has blocked the other, refuse the send (403 "You can't message this user"). This also stops notifications/push to a blocker.
4. **UI** — in `ChatRoomView.tsx` profile modal (lines 23+), add a "Block / Unblock" button that calls `/api/blocks`. Blocked conversations are hidden from the list (filter in `ChatListView`); tapping a blocked thread shows "You blocked this user" instead of the composer.

## RLS hardening (your "tighten RLS too" choice) — same `migration_v4_4.sql`
```sql
DROP POLICY IF EXISTS "conv_read" ON conversations;
CREATE POLICY "conv_read" ON conversations FOR SELECT
  TO authenticated USING (auth.uid() = user_id_1 OR auth.uid() = user_id_2);
DROP POLICY IF EXISTS "msg_read" ON messages;
CREATE POLICY "msg_read" ON messages FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM conversations c
            WHERE c.id = messages.conversation_id
              AND (auth.uid() = c.user_id_1 OR auth.uid() = c.user_id_2))
  );
```
This makes RLS a real backstop behind the app-level checks and closes the realtime cross-read hole. Safe because writes go through the service-role API (bypasses RLS); the browser anon client only ever SELECTs.

## Files changed
| File | Change |
|---|---|
| `app/api/conversations/route.ts` | +auth on GET & POST (S1, S3) |
| `app/api/conversations/[id]/route.ts` | +auth + membership on GET (S2) |
| `app/api/business-products/route.ts` | +`requireSupplierAccess` on GET (S5) |
| `lib/useMyProductIds.ts` | +`authHeaders()` on the fetch (S5) |
| `components/AdminDashboard.tsx` | +`authHeaders()` on the fetch (S5) |
| `app/api/conversations/[id]/messages/route.ts` | +rate limit + block check (S6) |
| `app/api/blocks/route.ts` | **new** — block/unblock/list endpoints (S6) |
| `views/ChatRoomView.tsx` | +Block/Unblock button in profile modal (S6) |
| `views/ChatListView.tsx` | hide blocked conversations (S6) |
| `supabase/migration_v4_4.sql` | **new** — photo upload policy, blocked_users table, tightened chat RLS (S4, S6, RLS) |

## Verification
- `npm run build` to confirm everything compiles.
- Grep to confirm no remaining unauthenticated chat reads.
- Manual: open chat as logged-in user (works); try the endpoints with no token (401) and as a non-participant (403).
- Test block: block a user → their messages stop, conversation hides, push stops.

## Note on the migration
`supabase/migration_v4_4.sql` is a file you must **run in the Supabase SQL editor** (I'll write it; I won't execute it against your live DB). The app-level fixes (S1/S2/S3/S5/S6 rate-limit) work immediately without it, but the photo-upload lock, block table, and RLS hardening require running the SQL. I'll call that out clearly when done.