ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS is_session_active boolean NOT NULL DEFAULT false;

UPDATE public.devices d
   SET is_session_active = EXISTS (
     SELECT 1 FROM public.sessions s
      WHERE s.device_id = d.id
        AND s.state IN ('invited','active')
   );

CREATE OR REPLACE FUNCTION public.sync_device_session_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE target uuid;
BEGIN
  target := COALESCE(NEW.device_id, OLD.device_id);
  IF target IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  UPDATE public.devices
     SET is_session_active = EXISTS (
       SELECT 1 FROM public.sessions
        WHERE device_id = target
          AND state IN ('invited','active')
     )
   WHERE id = target;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sessions_sync_device_active ON public.sessions;
CREATE TRIGGER trg_sessions_sync_device_active
AFTER INSERT OR UPDATE OF state, device_id OR DELETE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.sync_device_session_active();