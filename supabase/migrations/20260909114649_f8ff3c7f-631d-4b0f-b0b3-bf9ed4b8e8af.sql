-- 1) Allow the new "stopped" device status.
-- devices.status is a free text column today; add a CHECK to keep it constrained.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_status_check'
  ) THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_status_check;
  END IF;
END $$;

ALTER TABLE public.devices
  ADD CONSTRAINT devices_status_check
  CHECK (status IN ('online','offline','stopped'));

-- 2) New per-admin toggle for the "agent stopped" alert.
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS notify_on_agent_stopped boolean NOT NULL DEFAULT true;

-- 3) Expected devices roster.
CREATE TABLE IF NOT EXISTS public.expected_devices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, hostname)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.expected_devices TO authenticated;
GRANT ALL ON public.expected_devices TO service_role;

ALTER TABLE public.expected_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expected_devices_owner_all"
  ON public.expected_devices
  FOR ALL
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE INDEX IF NOT EXISTS expected_devices_hostname_lower_idx
  ON public.expected_devices ((lower(hostname)));

CREATE TRIGGER expected_devices_touch_updated_at
  BEFORE UPDATE ON public.expected_devices
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();