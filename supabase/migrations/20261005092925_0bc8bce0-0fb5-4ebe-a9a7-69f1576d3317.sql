ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'windows';
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_platform_check;
ALTER TABLE public.devices ADD CONSTRAINT devices_platform_check CHECK (platform IN ('windows','android'));

ALTER TABLE public.power_commands DROP CONSTRAINT power_commands_kind_check;
ALTER TABLE public.power_commands ADD CONSTRAINT power_commands_kind_check CHECK (kind IN ('wake','wake_agent','reboot','shutdown','lock','logoff','restart_stream','restart_agent','switch_monitor','restart_app'));

CREATE OR REPLACE FUNCTION public.enforce_power_command_platform()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE p text;
BEGIN
  SELECT platform INTO p FROM public.devices WHERE id = NEW.device_id;
  IF p = 'android' AND NEW.kind NOT IN ('reboot','lock','restart_stream','restart_app') THEN
    RAISE EXCEPTION 'unsupported_for_platform: % on android', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(p,'windows') = 'windows' AND NEW.kind = 'restart_app' THEN
    RAISE EXCEPTION 'unsupported_for_platform: restart_app on windows' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_power_command_platform ON public.power_commands;
CREATE TRIGGER trg_power_command_platform BEFORE INSERT ON public.power_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_power_command_platform();

ALTER TABLE public.releases DROP CONSTRAINT releases_product_check;
ALTER TABLE public.releases ADD CONSTRAINT releases_product_check CHECK (product IN ('agent','admin','android'));

ALTER TABLE public.expected_devices ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'windows';
ALTER TABLE public.expected_devices ADD CONSTRAINT expected_devices_platform_check CHECK (platform IN ('windows','android'));
ALTER TABLE public.expected_devices ADD COLUMN IF NOT EXISTS claim_code text;
ALTER TABLE public.expected_devices ADD COLUMN IF NOT EXISTS claimed_device_id uuid REFERENCES public.devices(id) ON DELETE SET NULL;
ALTER TABLE public.expected_devices ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS expected_devices_claim_code_uq ON public.expected_devices(claim_code) WHERE claim_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_platform ON public.devices(platform);