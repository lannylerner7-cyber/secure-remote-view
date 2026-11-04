-- Current monthly USD prices. Preserve device allowances, existing licenses,
-- paid orders and pending invoices: an issued invoice keeps its locked amount.
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.plans
      WHERE code IN ('starter', 'team', 'business')) <> 3 THEN
    RAISE EXCEPTION 'Expected Starter, Team and Business plans before repricing';
  END IF;
END;
$$;

UPDATE public.plans AS plan
SET amount_usd = price.amount_usd,
    updated_at = now()
FROM (VALUES
  ('starter', 19.00),
  ('team', 35.00),
  ('business', 86.00)
) AS price(code, amount_usd)
WHERE plan.code = price.code
  AND plan.amount_usd IS DISTINCT FROM price.amount_usd;

COMMIT;
