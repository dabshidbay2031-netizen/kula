-- ============================================================
-- RUN-THIS-audit-parts-2-4.sql
--
-- Everything the Part 2-4 code changes need. Paste into the Supabase SQL
-- editor and run. Idempotent: safe to re-run. Nothing is deleted.
--
--   M1  atomic stock take/return  (stops overselling the last item)
--   M5  orders.idempotency_key    (stops double-tap duplicate orders)
--   M7  payment_method CHECK      (stops "freemoney" skipping the 3% fee)
--   P2  admin_revenue_total()     (SUM in SQL, not 100k rows through Node)
--
-- The app degrades gracefully without this file — it falls back to the old
-- behaviour — but M1's race is only truly closed once decrement_stock exists.
-- ============================================================

-- ── M1: atomic stock movement ───────────────────────────────
-- The read-modify-write in JS could interleave: two buyers both read stock=1,
-- both passed the check, both wrote stock=0. Doing it in ONE statement makes
-- the guard and the decrement inseparable — Postgres locks the row for us.
CREATE OR REPLACE FUNCTION decrement_stock(p_id BIGINT, p_qty INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_hit INT;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE products
     SET stock = stock - p_qty,
         sold  = COALESCE(sold, 0) + p_qty
   WHERE id = p_id
     AND stock >= p_qty;          -- ← the guard and the write, atomically

  GET DIAGNOSTICS v_hit = ROW_COUNT;
  RETURN v_hit > 0;               -- FALSE = not enough stock, nothing changed
END;
$$;

-- Compensating action: hand stock back when the order insert fails after the
-- stock was already taken. Never pushes `sold` below zero.
CREATE OR REPLACE FUNCTION restore_stock(p_id BIGINT, p_qty INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE products
     SET stock = stock + p_qty,
         sold  = GREATEST(COALESCE(sold, 0) - p_qty, 0)
   WHERE id = p_id;

  RETURN FOUND;
END;
$$;

-- ── M5: idempotency ─────────────────────────────────────────
-- One key per checkout attempt. A retry of the same key returns the original
-- order instead of charging the customer twice.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index: many NULLs allowed, but a given key can exist once.
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uniq
  ON orders(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── M7: payment method whitelist ────────────────────────────
-- Belt and braces behind the API's whitelist. Existing rows are normalised
-- first so the constraint can be added without failing on legacy junk.
UPDATE orders
   SET payment_method = 'cash'
 WHERE payment_method IS NULL
    OR payment_method NOT IN ('cash','bulk','invoice','card','sifalo','waafi','evc','edahab','pbwallet');

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN ('cash','bulk','invoice','card','sifalo','waafi','evc','edahab','pbwallet'));

-- ── P2: revenue as a SQL aggregate ──────────────────────────
-- Mirrors lib/revenue.ts sumRevenue(): cancelled / refunded / deleted money
-- never counts. `exclude_seed` is ignored when the is_seed column is absent.
CREATE OR REPLACE FUNCTION admin_revenue_total(exclude_seed BOOLEAN DEFAULT TRUE)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_total NUMERIC;
  v_has_seed BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'orders' AND column_name = 'is_seed'
  ) INTO v_has_seed;

  IF exclude_seed AND v_has_seed THEN
    EXECUTE $q$
      SELECT COALESCE(SUM(total), 0) FROM orders
       WHERE status NOT IN ('cancelled','refunded','deleted') AND NOT is_seed
    $q$ INTO v_total;
  ELSE
    SELECT COALESCE(SUM(total), 0) INTO v_total
      FROM orders
     WHERE status NOT IN ('cancelled','refunded','deleted');
  END IF;

  RETURN v_total;
END;
$$;

-- Index that makes both the aggregate and the order lists cheap.
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status, created_at DESC);

-- ── M1 (full): one transaction for EVERY order ──────────────
-- place_order() couldn't price bulk tiers or take a staff discount, so those
-- sales fell to a JS path where the order insert and the stock move were two
-- separate statements. This version keeps pricing in JS (where the tier and
-- discount rules already live and are unit-tested) and does the part that must
-- be atomic — lock, verify, decrement, insert order, insert lines — in ONE
-- transaction. A failure anywhere rolls the whole thing back.
--
-- p_items: [{ id, qty, unit_price, supplier_id }]
CREATE OR REPLACE FUNCTION place_order_v2(p_order JSONB, p_items JSONB)
RETURNS orders
LANGUAGE plpgsql
AS $$
DECLARE
  v_item     JSONB;
  v_pid      BIGINT;
  v_qty      INTEGER;
  v_unit     NUMERIC(10,2);
  v_supplier INTEGER;
  v_stock    INTEGER;
  v_skip     BOOLEAN := COALESCE((p_order->>'skip_stock')::BOOLEAN, FALSE);
  v_order    orders%ROWTYPE;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order has no items';
  END IF;

  -- 1. Take the stock first, locking each row so two buyers can't both pass.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_pid := (v_item->>'id')::BIGINT;
    v_qty := GREATEST(COALESCE((v_item->>'qty')::INTEGER, 1), 1);

    SELECT stock INTO v_stock FROM products WHERE id = v_pid FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_MISSING:%', v_pid;
    END IF;

    IF NOT v_skip THEN
      IF v_stock < v_qty THEN
        RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_pid;
      END IF;
      UPDATE products
         SET stock = stock - v_qty,
             sold  = COALESCE(sold, 0) + v_qty
       WHERE id = v_pid;
    END IF;
  END LOOP;

  -- 2. The order itself, priced entirely by the caller.
  INSERT INTO orders (
    id, customer_name, customer_phone, user_id, items,
    subtotal, discount, total, payment_method, status, notes,
    supplier_id, session_id, cashier_name, idempotency_key
  ) VALUES (
    COALESCE(p_order->>'id', gen_random_uuid()::TEXT),
    COALESCE(p_order->>'customer_name', ''),
    COALESCE(p_order->>'customer_phone', ''),
    p_order->>'user_id',
    COALESCE(p_order->'items', p_items),
    COALESCE((p_order->>'subtotal')::NUMERIC, 0),
    COALESCE((p_order->>'discount')::NUMERIC, 0),
    COALESCE((p_order->>'total')::NUMERIC, 0),
    COALESCE(p_order->>'payment_method', 'cash'),
    COALESCE(p_order->>'status', 'pending'),
    p_order->>'notes',
    NULLIF(p_order->>'supplier_id', '')::INTEGER,
    NULLIF(p_order->>'session_id', '')::UUID,
    p_order->>'cashier_name',
    p_order->>'idempotency_key'
  )
  RETURNING * INTO v_order;

  -- 3. Normalized sales lines, in the same transaction as the sale.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_pid      := (v_item->>'id')::BIGINT;
    v_qty      := GREATEST(COALESCE((v_item->>'qty')::INTEGER, 1), 1);
    v_unit     := COALESCE((v_item->>'unit_price')::NUMERIC, 0);
    v_supplier := NULLIF(v_item->>'supplier_id', '')::INTEGER;

    INSERT INTO order_items (order_id, product_id, supplier_id, qty, unit_price, line_total)
    VALUES (v_order.id, v_pid, v_supplier, v_qty, v_unit, ROUND(v_unit * v_qty, 2));
  END LOOP;

  RETURN v_order;
END;
$$;

-- ── Check it worked ─────────────────────────────────────────
SELECT 'decrement_stock'     AS object, to_regprocedure('decrement_stock(bigint,int)')     IS NOT NULL AS installed
UNION ALL SELECT 'restore_stock',       to_regprocedure('restore_stock(bigint,int)')       IS NOT NULL
UNION ALL SELECT 'admin_revenue_total', to_regprocedure('admin_revenue_total(boolean)')    IS NOT NULL
UNION ALL SELECT 'place_order_v2',      to_regprocedure('place_order_v2(jsonb,jsonb)')     IS NOT NULL
UNION ALL SELECT 'idempotency_key',     EXISTS (SELECT 1 FROM information_schema.columns
                                                 WHERE table_name='orders' AND column_name='idempotency_key');
