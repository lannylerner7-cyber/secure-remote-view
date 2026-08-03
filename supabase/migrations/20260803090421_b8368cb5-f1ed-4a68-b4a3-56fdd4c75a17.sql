CREATE TABLE IF NOT EXISTS public.cron_tokens (
  name text PRIMARY KEY,
  token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.cron_tokens TO service_role;

ALTER TABLE public.cron_tokens ENABLE ROW LEVEL SECURITY;

INSERT INTO public.cron_tokens (name) VALUES ('reconcile-orders')
ON CONFLICT (name) DO NOTHING;

SELECT cron.unschedule('reconcile-orders');

SELECT cron.schedule(
  'reconcile-orders',
  '*/1 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://project--13b47594-1b4d-46c6-a939-da4132e55c1c.lovable.app/api/public/cron/reconcile-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT token FROM public.cron_tokens WHERE name = 'reconcile-orders')
    ),
    body := '{}'::jsonb
  );
  $job$
);