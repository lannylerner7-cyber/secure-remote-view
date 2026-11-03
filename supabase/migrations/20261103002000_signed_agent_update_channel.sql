-- Keep installer downloads separate from publisher-signed runtime bundles.
-- Apply in the deployment migration process; no existing releases are changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.releases DROP CONSTRAINT releases_channel_check;
ALTER TABLE public.releases ADD CONSTRAINT releases_channel_check
  CHECK (channel IN ('stable', 'beta', 'stable-update'));
ALTER TABLE public.releases ADD CONSTRAINT releases_runtime_product_check
  CHECK (channel <> 'stable-update' OR product = 'agent');
COMMIT;
