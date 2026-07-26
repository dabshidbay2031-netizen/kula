-- ============================================================
-- migration_v4_4.sql — Security hardening (Part 1 of the audit)
--
-- Closes three classes of hole documented in AUDIT-FULL-REPORT.md:
--   S4  chat photo uploads were anonymous + world-readable
--   S6  blocked_users table for the block/spam feature
--   RLS conversations/messages SELECT was USING(true) = everyone reads
--
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.
-- ============================================================

-- ── S4: chat-images uploads ─────────────────────────────
-- The bucket stays PUBLIC-readable (existing image URLs in old messages keep
-- working; we chose not to switch to signed URLs). What changes is WHO can
-- upload: only authenticated users, and only into their own {uid}/ folder.
-- The upload path in ChatRoomView is already `${user.id}/${timestamp}.${ext}`,
-- so the first path segment is the owner — enforce it here.
DROP POLICY IF EXISTS "chat_images_upload" ON storage.objects;
CREATE POLICY "chat_images_upload" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- (Public read stays as-is — chat_images_public_read is unchanged.)

-- ── S6: blocked_users table ─────────────────────────────
-- One row per "blocker blocked target". A bidirectional block check at send
-- time (either party blocked the other) stops the message + the push.
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_uid TEXT        NOT NULL,
  blocked_uid  TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_uid, blocked_uid)
);
CREATE INDEX IF NOT EXISTS blocked_users_blocker_idx ON blocked_users(blocker_uid);
CREATE INDEX IF NOT EXISTS blocked_users_blocked_idx  ON blocked_users(blocked_uid);

ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;
-- A user may only read / write their OWN block rows.
DROP POLICY IF EXISTS "blocked_self" ON blocked_users;
CREATE POLICY "blocked_self" ON blocked_users FOR ALL
  TO authenticated
  USING    (blocker_uid = auth.uid()::text)
  WITH CHECK (blocker_uid = auth.uid()::text);

-- ── RLS hardening: conversations + messages ─────────────
-- Replaces the previous USING(true) "everyone can read" policies with real
-- participant checks. This makes RLS a genuine backstop behind the app-level
-- requireParticipant checks in the /api routes, and closes the realtime
-- cross-read hole (an anon-key browser could subscribe to any conversation's
-- message INSERTs under USING(true)).
--
-- Writes are unaffected: the /api routes use the service-role key, which
-- bypasses RLS. Only the browser anon client is gated here, and it only ever
-- SELECTs.
DROP POLICY IF EXISTS "conv_read" ON conversations;
CREATE POLICY "conv_read" ON conversations FOR SELECT
  TO authenticated
  USING (auth.uid()::text = user_id_1 OR auth.uid()::text = user_id_2);

DROP POLICY IF EXISTS "msg_read" ON messages;
CREATE POLICY "msg_read" ON messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (auth.uid()::text = c.user_id_1 OR auth.uid()::text = c.user_id_2)
    )
  );
