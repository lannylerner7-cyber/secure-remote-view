CREATE OR REPLACE FUNCTION public.enforce_power_command_platform()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  p text;
BEGIN
  SELECT platform INTO p FROM public.devices WHERE id = NEW.device_id;
  IF p = 'android' AND NEW.kind = 'reboot' THEN
    RAISE EXCEPTION 'unsupported_for_platform: Android device reboot is disabled until verified Device Owner provisioning exists' USING ERRCODE = 'check_violation';
  END IF;
  IF p = 'android' AND NEW.kind NOT IN ('lock','restart_stream','restart_app') THEN
    RAISE EXCEPTION 'unsupported_for_platform: % on android', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(p,'windows') = 'windows' AND NEW.kind = 'restart_app' THEN
    RAISE EXCEPTION 'unsupported_for_platform: restart_app on windows' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_power_command_platform ON public.power_commands;
CREATE TRIGGER trg_power_command_platform BEFORE INSERT OR UPDATE OF device_id, kind ON public.power_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_power_command_platform();