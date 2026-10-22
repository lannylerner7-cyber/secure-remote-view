-- Restrict untrusted REST/RPC callers independently of permissive owner RLS.
-- Trusted device-authenticated server routes use service_role and must perform
-- their own state/ownership checks. This is not an enrollment-grant mechanism.
CREATE OR REPLACE FUNCTION public.guard_client_session_transitions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role'
     OR (auth.role() IS NULL AND current_user IN ('postgres', 'supabase_admin')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'invited' OR NEW.consent_at IS NOT NULL THEN
      RAISE EXCEPTION 'New sessions require device authorization'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.technician_id IS DISTINCT FROM OLD.technician_id
     OR NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    RAISE EXCEPTION 'Session identity and consent are server-managed'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NEW.state NOT IN ('paused', 'ended') THEN
    RAISE EXCEPTION 'Session activation requires device authorization'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state IN ('ended', 'declined') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Closed sessions cannot be reopened'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode AND NEW.mode IS DISTINCT FROM 'view' THEN
    RAISE EXCEPTION 'Control escalation requires separate authorization'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_client_session_transitions ON public.sessions;
CREATE TRIGGER guard_client_session_transitions
BEFORE INSERT OR UPDATE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_client_session_transitions();
