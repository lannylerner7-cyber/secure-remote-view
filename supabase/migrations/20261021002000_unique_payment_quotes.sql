-- A quote is permanently reserved: do not reuse expired amounts, since a
-- late payment must not be attributed to a newer invoice.
CREATE TABLE public.payment_quote_reservations (
  order_id uuid PRIMARY KEY,
  coin text NOT NULL CHECK (coin IN ('BTC','USDT_ERC20','USDC_ERC20')),
  address text NOT NULL,
  amount numeric(38,18) NOT NULL CHECK (amount > 0),
  base_amount numeric(38,18) NOT NULL CHECK (base_amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coin, address, amount)
);
ALTER TABLE public.payment_quote_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_quote_reservations FROM anon, authenticated;
GRANT ALL ON public.payment_quote_reservations TO service_role;

CREATE FUNCTION public.create_unique_payment_order(_order jsonb, _base_amount numeric)
RETURNS TABLE(order_id uuid, quoted_amount numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c text := _order->>'coin';
  a text := trim(_order->>'receive_address');
  oid uuid := gen_random_uuid();
  unit numeric;
  candidate numeric;
  offset_units integer;
BEGIN
  IF c IS NULL OR c NOT IN ('BTC','USDT_ERC20','USDC_ERC20')
     OR a IS NULL OR length(a) < 10 OR _base_amount IS NULL
     OR _base_amount <= 0 OR _base_amount::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Invalid payment quote';
  END IF;
  IF c <> 'BTC' THEN a := lower(a); END IF;
  unit := CASE WHEN c = 'BTC' THEN 0.00000001 ELSE 0.000001 END;
  IF mod(_base_amount, unit) <> 0 THEN
    RAISE EXCEPTION 'Quote exceeds currency precision';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(c || ':' || a, 0));
  FOR offset_units IN 0..99 LOOP
    candidate := _base_amount + offset_units * unit;
    -- Include pre-migration invoices in the collision check.
    IF EXISTS (SELECT 1 FROM public.orders o WHERE o.coin = c
      AND (CASE WHEN c = 'BTC' THEN o.receive_address ELSE lower(o.receive_address) END) = a
      AND o.amount_coin = candidate) THEN CONTINUE; END IF;
    INSERT INTO public.payment_quote_reservations(order_id,coin,address,amount,base_amount)
      VALUES (oid,c,a,candidate,_base_amount) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO public.orders (
      id,email,full_name,phone,company,plan_code,amount_usd,coin,amount_coin,
      price_locked_at,price_expires_at,receive_address,status
    ) VALUES (
      oid,_order->>'email',_order->>'full_name',_order->>'phone',_order->>'company',
      _order->>'plan_code',(_order->>'amount_usd')::numeric,c,candidate,
      (_order->>'price_locked_at')::timestamptz,
      (_order->>'price_expires_at')::timestamptz,a,'pending'
    );
    RETURN QUERY SELECT oid,candidate;
    RETURN;
  END LOOP;
  RAISE EXCEPTION 'No unique quote available within the permitted adjustment; retry later';
END;
$$;
REVOKE ALL ON FUNCTION public.create_unique_payment_order(jsonb,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_unique_payment_order(jsonb,numeric) TO service_role;
