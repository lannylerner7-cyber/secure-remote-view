-- Preserve client state/identity guards; permit control only under the session's
-- already-recorded grant. No new capabilities, enrollment or consent is created.
CREATE OR REPLACE FUNCTION public.session_control_granted(_session_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public AS $$
DECLARE allowed boolean;
BEGIN
  IF NOT public.session_authorized(_session_id, 'view') THEN RETURN false; END IF;
  SELECT a.capabilities->'control' = 'true'::jsonb AND a.revoked_at IS NULL
    INTO allowed
    FROM public.sessions s
    JOIN public.device_authorizations a ON a.id = s.authorization_id
      AND a.device_id = s.device_id
    WHERE s.id = _session_id AND s.state = 'active'
    FOR SHARE OF a;
  RETURN COALESCE(allowed, false);
END;
$$;
REVOKE ALL ON FUNCTION public.session_control_granted(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_control_granted(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_client_session_transitions()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.role() = 'service_role'
     OR (auth.role() IS NULL AND current_user IN ('postgres', 'supabase_admin')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'invited' OR NEW.consent_at IS NOT NULL THEN
      RAISE EXCEPTION 'New sessions require device authorization' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.technician_id IS DISTINCT FROM OLD.technician_id
     OR NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    RAISE EXCEPTION 'Session identity and consent are server-managed' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state NOT IN ('paused', 'ended') THEN
    RAISE EXCEPTION 'Session activation requires device authorization' USING ERRCODE = '42501';
  END IF;
  IF OLD.state IN ('ended', 'declined') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Closed sessions cannot be reopened' USING ERRCODE = '42501';
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode AND NEW.mode IS DISTINCT FROM 'view' THEN
    IF NEW.mode IS DISTINCT FROM 'control' OR NEW.state IS DISTINCT FROM 'active'
       OR NOT public.session_control_granted(OLD.id) THEN
      RAISE EXCEPTION 'Control requires an active session and recorded control grant'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
