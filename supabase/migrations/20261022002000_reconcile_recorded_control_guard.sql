-- Reconcile the second session trigger as well as the client-transition guard.
CREATE OR REPLACE FUNCTION public.guard_recorded_session_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.device_authorizations%ROWTYPE;
  owner uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
      RAISE EXCEPTION 'session_identity_immutable' USING ERRCODE = '42501';
    END IF;
    IF (NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
        OR NEW.authorization_mode IS DISTINCT FROM OLD.authorization_mode)
       AND NOT (auth.role() = 'service_role' AND OLD.state = 'invited' AND NEW.state = 'active') THEN
      RAISE EXCEPTION 'authorization_binding_immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.state IN ('ended','declined') AND NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'closed_session' USING ERRCODE = '42501';
    END IF;
    IF NEW.state = 'active' AND OLD.state NOT IN ('invited','active') THEN
      RAISE EXCEPTION 'new_invitation_required' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'active' AND NEW.mode IS DISTINCT FROM OLD.mode AND NEW.mode <> 'view' THEN
      IF NEW.mode <> 'control' OR NEW.state <> 'active'
         OR NOT public.session_control_granted(OLD.id) THEN
        RAISE EXCEPTION 'recorded_control_authorization_required' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    IF NEW.state <> 'invited' OR NEW.authorization_id IS NOT NULL OR NEW.authorization_mode IS NOT NULL OR NEW.consent_at IS NOT NULL THEN
      RAISE EXCEPTION 'invitation_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.mode NOT IN ('view','control') THEN RAISE EXCEPTION 'invalid_session_mode'; END IF;
  IF NEW.state = 'active' THEN
    PERFORM 1 FROM public.devices WHERE id = NEW.device_id FOR UPDATE;
    SELECT l.user_id INTO owner FROM public.devices d LEFT JOIN public.licenses l ON l.id = d.license_id WHERE d.id = NEW.device_id;
    SELECT * INTO a FROM public.device_authorizations WHERE id = NEW.authorization_id FOR SHARE;
    IF NOT FOUND OR a.device_id IS DISTINCT FROM NEW.device_id OR a.revoked_at IS NOT NULL
       OR a.notice_version <> 1 OR a.owner_id IS DISTINCT FROM owner
       OR NEW.authorization_mode IS DISTINCT FROM a.mode OR NEW.consent_at IS NULL
       OR a.capabilities->'view' IS DISTINCT FROM 'true'::jsonb
       OR (NEW.mode = 'control' AND a.capabilities->'control' IS DISTINCT FROM 'true'::jsonb) THEN
      RAISE EXCEPTION 'recorded_authorization_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.admin_client_id IS DISTINCT FROM OLD.admin_client_id
     AND NEW.admin_client_id IS NOT NULL AND NOT public.session_authorized(OLD.id,'view') THEN
    RAISE EXCEPTION 'binding_requires_active_authorization' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
