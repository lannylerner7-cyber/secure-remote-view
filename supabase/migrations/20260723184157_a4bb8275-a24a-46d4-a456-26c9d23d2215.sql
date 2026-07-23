
-- Plans catalog
CREATE TABLE public.plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text,
  amount_usd numeric(12,2) NOT NULL CHECK (amount_usd >= 0),
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.plans TO anon, authenticated;
GRANT ALL ON public.plans TO service_role;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans_public_read_active" ON public.plans FOR SELECT USING (active = true);
CREATE POLICY "plans_admin_read_all" ON public.plans FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "plans_superadmin_write" ON public.plans FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
CREATE TRIGGER plans_touch BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

INSERT INTO public.plans (code, name, description, amount_usd, sort_order) VALUES
  ('starter',  'Starter — 1 device',    'Single-device remote support license.',       49.00, 10),
  ('team',     'Team — 5 devices',      'Small-team fleet license for up to 5 seats.', 199.00, 20),
  ('business', 'Business — 25 devices', 'SMB fleet license with priority support.',    799.00, 30);

-- Admin CDP wallets (one row per coin/chain)
CREATE TABLE public.admin_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin text NOT NULL,
  chain text NOT NULL,
  cdp_wallet_id text NOT NULL,
  xpub text,
  addresses_issued int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coin, chain)
);
GRANT SELECT, INSERT, UPDATE ON public.admin_wallets TO authenticated;
GRANT ALL ON public.admin_wallets TO service_role;
ALTER TABLE public.admin_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wallets_admin_read" ON public.admin_wallets FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "wallets_superadmin_write" ON public.admin_wallets FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
CREATE TRIGGER admin_wallets_touch BEFORE UPDATE ON public.admin_wallets
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Orders
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  phone text,
  company text,
  plan_code text NOT NULL REFERENCES public.plans(code),
  amount_usd numeric(12,2) NOT NULL,
  coin text NOT NULL CHECK (coin IN ('BTC','USDT_ERC20','USDC_ERC20')),
  amount_coin numeric(38,18) NOT NULL,
  price_locked_at timestamptz NOT NULL DEFAULT now(),
  price_expires_at timestamptz NOT NULL,
  receive_address text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','detected','paid','expired','refunded','cancelled')),
  tx_hash text,
  confirmations int NOT NULL DEFAULT 0,
  access_link text,
  access_link_sent_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE INDEX orders_status_idx ON public.orders (status);
CREATE INDEX orders_created_idx ON public.orders (created_at DESC);
CREATE INDEX orders_receive_address_idx ON public.orders (receive_address) WHERE receive_address IS NOT NULL;
CREATE INDEX orders_email_idx ON public.orders (lower(email));

-- Only admins can read orders. No anon.
CREATE POLICY "orders_admin_read" ON public.orders FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "orders_admin_update" ON public.orders FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'));
-- Inserts happen from the public order form via server fn (service_role bypass) or admin.
CREATE POLICY "orders_admin_insert" ON public.orders FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Payment events (idempotent log)
CREATE TABLE public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('cdp_webhook','poller','admin')),
  event_type text NOT NULL,
  tx_hash text,
  confirmations int,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, tx_hash, event_type)
);
GRANT SELECT ON public.payment_events TO authenticated;
GRANT ALL ON public.payment_events TO service_role;
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_events_admin_read" ON public.payment_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'admin'));
CREATE INDEX payment_events_order_idx ON public.payment_events (order_id, created_at DESC);

-- Extend admin_settings with sweep + payout fields (per-technician rows already exist).
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS sweep_to_exchange_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payout_address_btc text,
  ADD COLUMN IF NOT EXISTS payout_address_eth text;

-- Public counter (only exposes an integer, no row data)
CREATE OR REPLACE FUNCTION public.get_paid_order_count()
RETURNS int
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::int FROM public.orders WHERE status = 'paid';
$$;
GRANT EXECUTE ON FUNCTION public.get_paid_order_count() TO anon, authenticated;
