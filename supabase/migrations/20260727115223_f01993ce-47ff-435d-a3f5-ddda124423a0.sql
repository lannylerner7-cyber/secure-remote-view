
-- 1. Payment event de-duplication
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_dedupe
  ON public.payment_events (order_id, COALESCE(tx_hash, ''), event_type);

-- 2. License lookup rate-limit table
CREATE TABLE IF NOT EXISTS public.license_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS license_lookups_email_ts_idx
  ON public.license_lookups (lower(email), created_at DESC);

GRANT ALL ON public.license_lookups TO service_role;
ALTER TABLE public.license_lookups ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (server code) reads/writes this table.

-- 3. Schedule the reconcile-orders poller via pg_cron + pg_net.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any previous schedule with the same name so this is idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('reconcile-orders');
EXCEPTION WHEN OTHERS THEN
  -- ignore if it doesn't exist
  NULL;
END $$;

SELECT cron.schedule(
  'reconcile-orders',
  '*/1 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://project--13b47594-1b4d-46c6-a939-da4132e55c1c.lovable.app/api/public/cron/reconcile-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_-6LC9u-eg5GW9n2yHRrZog_2lbuB7j_'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
