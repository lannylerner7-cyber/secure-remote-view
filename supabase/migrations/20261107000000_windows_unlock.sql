-- Opt-in extension, not an expansion of the existing pairing notice v1.
-- Ciphertext only: private keys and Windows Hello PINs never enter PostgreSQL.
BEGIN;
CREATE TABLE public.device_unlock_permissions (
  device_id uuid PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL REFERENCES public.device_authorizations(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version = 1),
  key_id uuid NOT NULL,
  public_key text NOT NULL CHECK (length(public_key) BETWEEN 500 AND 1200),
  windows_account text NOT NULL CHECK (length(windows_account) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at timestamptz,
  locked boolean,
  helper_ready boolean NOT NULL DEFAULT false,
  UNIQUE (device_id, key_id)
);
CREATE TABLE public.device_unlock_credentials (
  device_id uuid PRIMARY KEY,
  key_id uuid NOT NULL,
  credential_version uuid NOT NULL DEFAULT gen_random_uuid(),
  sealed_pin jsonb NOT NULL CHECK (octet_length(sealed_pin::text) < 4096),
  saved_by uuid NOT NULL REFERENCES auth.users(id),
  saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (device_id,key_id) REFERENCES public.device_unlock_permissions(device_id,key_id) ON DELETE CASCADE
);
CREATE TABLE public.device_unlock_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.device_unlock_permissions(device_id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  peer_id text NOT NULL CHECK (peer_id ~ '^[A-Za-z0-9_-]{16,64}$' OR peer_id ~ '^[0-9a-fA-F-]{36}$'),
  admin_client_id text NOT NULL,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '2 minutes',
  acquired_at timestamptz,
  pin_used_at timestamptz,
  ended_at timestamptz
);
CREATE INDEX device_unlock_recent_attempts ON public.device_unlock_attempts(device_id,created_at);
-- Minimal deletion receipts survive the device row. They contain no PIN,
-- ciphertext, name, user SID, or reusable bearer credential.
CREATE TABLE public.device_unlock_revocations (
  device_identity text NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  key_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cleared_at timestamptz,
  PRIMARY KEY (device_identity,key_id)
);
ALTER TABLE public.device_unlock_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_unlock_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_unlock_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_unlock_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_unlock_permissions, public.device_unlock_credentials,
  public.device_unlock_attempts, public.device_unlock_revocations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.device_unlock_permissions, public.device_unlock_credentials,
  public.device_unlock_attempts, public.device_unlock_revocations TO service_role;

CREATE FUNCTION public.unlock_parent_allowed(_device uuid, _authorization uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.devices d
    JOIN public.licenses l ON l.id=d.license_id
    JOIN public.device_authorizations a ON a.device_id=d.id AND a.id=_authorization
    WHERE d.id=_device AND d.platform='windows' AND a.revoked_at IS NULL
      AND a.mode='unattended' AND a.notice_version=1 AND a.owner_id=l.user_id
      AND a.capabilities->'view'='true'::jsonb AND a.capabilities->'control'='true'::jsonb
      AND l.status='active' AND l.starts_at<=now() AND l.expires_at>now()
  );
$$;
CREATE FUNCTION public.unlock_device_status(_device uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('deviceId',_device,'enabled',
    p.device_id IS NOT NULL AND public.unlock_parent_allowed(_device,p.authorization_id),
    'authorizationId',p.authorization_id,'keyId',p.key_id,'publicKey',p.public_key,
    'windowsAccount',p.windows_account,
    'locked',CASE WHEN p.seen_at>now()-interval '15 seconds' THEN p.locked ELSE NULL END,
    'helperReady',COALESCE(p.helper_ready AND p.seen_at>now()-interval '15 seconds',false),
    'hasPin',c.device_id IS NOT NULL,'credentialVersion',c.credential_version,'lastSeenAt',p.seen_at)
  FROM (SELECT _device AS id) d
  LEFT JOIN public.device_unlock_permissions p ON p.device_id=d.id
  LEFT JOIN public.device_unlock_credentials c ON c.device_id=d.id;
$$;

CREATE FUNCTION public.unlock_admin(_actor uuid,_device uuid,_action text,_body jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.device_unlock_permissions%ROWTYPE; s public.sessions%ROWTYPE;
  a public.device_unlock_attempts%ROWTYPE; envelope jsonb; manager boolean;
BEGIN
  -- Service-only API; actor identity is derived from its authenticated request.
  PERFORM 1 FROM public.devices WHERE id=_device FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unlock_forbidden'; END IF;
  manager := public.can_manage_agent(_actor,_device);
  IF _action='status' AND NOT manager AND NOT EXISTS (
    SELECT 1 FROM public.sessions visible_session
      WHERE visible_session.device_id=_device AND visible_session.technician_id=_actor
      AND public.session_authorized(visible_session.id,'view')
  ) THEN RAISE EXCEPTION 'unlock_forbidden'; END IF;
  IF _action NOT IN ('begin','status') AND NOT manager THEN RAISE EXCEPTION 'unlock_forbidden'; END IF;
  IF _action='status' THEN RETURN public.unlock_device_status(_device) || jsonb_build_object('canManage',manager); END IF;
  IF _action='forget' THEN
    DELETE FROM public.device_unlock_credentials WHERE device_id=_device;
    UPDATE public.device_unlock_attempts SET ended_at=clock_timestamp() WHERE device_id=_device AND ended_at IS NULL;
    INSERT INTO public.audit_logs(device_id,event,detail) VALUES (_device,'unlock.pin_forgotten',jsonb_build_object('actor',_actor));
    RETURN public.unlock_device_status(_device);
  END IF;
  IF _action='revoke' THEN
    DELETE FROM public.device_unlock_permissions WHERE device_id=_device;
    INSERT INTO public.audit_logs(device_id,event,detail) VALUES (_device,'unlock.revoked',jsonb_build_object('actor',_actor));
    RETURN public.unlock_device_status(_device);
  END IF;
  SELECT * INTO p FROM public.device_unlock_permissions WHERE device_id=_device;
  IF NOT FOUND OR NOT public.unlock_parent_allowed(_device,p.authorization_id) THEN RAISE EXCEPTION 'unlock_setup_required'; END IF;
  IF _action='save' THEN
    envelope := _body->'sealedPin';
    IF _body->>'authorizationId' IS DISTINCT FROM p.authorization_id::text OR
      envelope->>'keyId' IS DISTINCT FROM p.key_id::text THEN RAISE EXCEPTION 'unlock_key_changed'; END IF;
    IF jsonb_typeof(envelope)<>'object' OR
      (SELECT count(*) FROM jsonb_object_keys(envelope))<>6 OR
      envelope->'version' IS DISTINCT FROM '1'::jsonb OR
      envelope->>'algorithm' IS DISTINCT FROM 'RSA-OAEP-256+A256GCM' OR
      length(COALESCE(envelope->>'wrappedKey',''))<>512 OR
      COALESCE(envelope->>'wrappedKey','') !~ '^[A-Za-z0-9+/]+$' OR
      COALESCE(envelope->>'iv','') !~ '^[A-Za-z0-9+/]{16}$' OR
      COALESCE(envelope->>'ciphertext','') !~ '^[A-Za-z0-9+/]{26,192}={0,2}$'
      THEN RAISE EXCEPTION 'invalid_unlock_request'; END IF;
    INSERT INTO public.device_unlock_credentials(device_id,key_id,sealed_pin,saved_by)
      VALUES (_device,p.key_id,envelope,_actor)
      ON CONFLICT (device_id) DO UPDATE SET sealed_pin=EXCLUDED.sealed_pin,
        key_id=EXCLUDED.key_id,credential_version=gen_random_uuid(),saved_by=_actor,saved_at=clock_timestamp();
    UPDATE public.device_unlock_attempts SET ended_at=clock_timestamp() WHERE device_id=_device AND ended_at IS NULL;
    INSERT INTO public.audit_logs(device_id,event,detail) VALUES (_device,'unlock.pin_saved',jsonb_build_object('actor',_actor));
    RETURN public.unlock_device_status(_device);
  END IF;
  IF _action<>'begin' THEN RAISE EXCEPTION 'invalid_unlock_request'; END IF;
  SELECT * INTO s FROM public.sessions WHERE id=(_body->>'sessionId')::uuid AND device_id=_device;
  IF NOT FOUND OR s.authorization_id IS DISTINCT FROM p.authorization_id OR
    NOT public.session_authorized(s.id,'view') OR
    s.technician_id IS DISTINCT FROM _actor OR s.admin_client_id IS NULL OR
    NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id=_actor
      AND r.role::text IN ('admin','super_admin','technician')) OR
    NOT p.helper_ready OR p.locked IS DISTINCT FROM true OR
    p.seen_at IS NULL OR p.seen_at<clock_timestamp()-interval '15 seconds'
    THEN RAISE EXCEPTION 'unlock_session_unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM public.device_unlock_attempts WHERE device_id=_device AND created_at>clock_timestamp()-interval '30 seconds') OR
    (SELECT count(*) FROM public.device_unlock_attempts WHERE device_id=_device AND created_at>clock_timestamp()-interval '15 minutes')>=5
    THEN RAISE EXCEPTION 'unlock_rate_limited'; END IF;
  UPDATE public.device_unlock_attempts SET ended_at=clock_timestamp() WHERE device_id=_device AND ended_at IS NULL;
  UPDATE public.sessions SET mode='view' WHERE id=s.id;
  INSERT INTO public.device_unlock_attempts(device_id,authorization_id,session_id,peer_id,admin_client_id,requested_by)
    VALUES (_device,p.authorization_id,s.id,_body->>'peerId',s.admin_client_id::text,_actor) RETURNING * INTO a;
  INSERT INTO public.audit_logs(device_id,event,detail)
    VALUES (_device,'unlock.requested',jsonb_build_object('actor',_actor,'request_id',a.id));
  RETURN jsonb_build_object('requestId',a.id,'expiresAt',a.expires_at);
END;
$$;

CREATE FUNCTION public.unlock_agent(_device uuid,_action text,_body jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.device_unlock_permissions%ROWTYPE; a public.device_unlock_attempts%ROWTYPE; pin jsonb;
BEGIN
  PERFORM 1 FROM public.devices WHERE id=_device FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unlock_forbidden'; END IF;
  IF _action='enable' THEN
    IF _body->'version' IS DISTINCT FROM '1'::jsonb OR
      NOT public.unlock_parent_allowed(_device,(_body->>'authorizationId')::uuid)
      THEN RAISE EXCEPTION 'unlock_forbidden'; END IF;
    SELECT * INTO p FROM public.device_unlock_permissions WHERE device_id=_device;
    IF FOUND AND p.key_id::text=_body->>'keyId' AND p.authorization_id::text=_body->>'authorizationId'
      AND p.public_key=_body->>'publicKey' THEN RETURN public.unlock_device_status(_device); END IF;
    -- Only an explicit local setup calls enable. Heartbeat never recreates it.
    DELETE FROM public.device_unlock_permissions WHERE device_id=_device;
    INSERT INTO public.device_unlock_permissions(device_id,authorization_id,version,key_id,public_key,windows_account)
      VALUES (_device,(_body->>'authorizationId')::uuid,1,(_body->>'keyId')::uuid,_body->>'publicKey',_body->>'windowsAccount');
    INSERT INTO public.audit_logs(device_id,event,detail) VALUES (_device,'unlock.locally_enabled','{"version":1}');
    RETURN public.unlock_device_status(_device);
  END IF;
  SELECT * INTO p FROM public.device_unlock_permissions WHERE device_id=_device;
  IF _action='status' THEN RETURN public.unlock_device_status(_device); END IF;
  IF NOT FOUND OR NOT public.unlock_parent_allowed(_device,p.authorization_id) OR
    _body->>'keyId' IS DISTINCT FROM p.key_id::text THEN RAISE EXCEPTION 'unlock_forbidden'; END IF;
  IF _action='report' THEN
    UPDATE public.device_unlock_permissions SET seen_at=clock_timestamp(),
      locked=CASE WHEN jsonb_typeof(_body->'locked')='boolean' THEN (_body->>'locked')::boolean ELSE NULL END,
      helper_ready=COALESCE(_body->'helperReady'='true'::jsonb,false) WHERE device_id=_device;
    RETURN public.unlock_device_status(_device);
  END IF;
  IF _action='revoke' THEN
    DELETE FROM public.device_unlock_permissions WHERE device_id=_device;
    RETURN jsonb_build_object('revoked',true);
  END IF;
  SELECT * INTO a FROM public.device_unlock_attempts WHERE id=(_body->>'requestId')::uuid AND device_id=_device FOR UPDATE;
  IF NOT FOUND OR a.ended_at IS NOT NULL OR a.expires_at<=clock_timestamp() OR
    a.authorization_id<>p.authorization_id OR _body->>'peerId' IS DISTINCT FROM a.peer_id OR
    _body->>'sessionId' IS DISTINCT FROM a.session_id::text OR NOT public.session_authorized(a.session_id,'view')
    OR NOT EXISTS (SELECT 1 FROM public.sessions current_session WHERE current_session.id=a.session_id
      AND current_session.technician_id=a.requested_by AND current_session.authorization_id=a.authorization_id
      AND current_session.admin_client_id::text=a.admin_client_id
      AND current_session.state='active')
    THEN RAISE EXCEPTION 'unlock_session_unavailable'; END IF;
  IF _action='acquire' THEN
    IF a.acquired_at IS NOT NULL THEN RAISE EXCEPTION 'unlock_session_unavailable'; END IF;
    UPDATE public.device_unlock_attempts SET acquired_at=clock_timestamp() WHERE id=a.id;
    RETURN jsonb_build_object('allowed',true,'expiresAt',a.expires_at);
  END IF;
  IF a.acquired_at IS NULL THEN RAISE EXCEPTION 'unlock_session_unavailable'; END IF;
  IF _action='permit' THEN RETURN jsonb_build_object('allowed',true); END IF;
  IF _action='pin' THEN
    IF a.pin_used_at IS NOT NULL THEN RAISE EXCEPTION 'unlock_session_unavailable'; END IF;
    SELECT sealed_pin INTO pin FROM public.device_unlock_credentials WHERE device_id=_device AND key_id=p.key_id;
    IF pin IS NULL THEN RAISE EXCEPTION 'unlock_setup_required'; END IF;
    -- Consume before returning ciphertext. Lost/uncertain replies are NOT retried.
    UPDATE public.device_unlock_attempts SET pin_used_at=clock_timestamp() WHERE id=a.id;
    INSERT INTO public.audit_logs(device_id,event,detail) VALUES (_device,'unlock.pin_requested',jsonb_build_object('request_id',a.id));
    RETURN jsonb_build_object('sealedPin',pin);
  END IF;
  IF _action='end' THEN
    UPDATE public.device_unlock_attempts SET ended_at=clock_timestamp() WHERE id=a.id;
    INSERT INTO public.audit_logs(device_id,event,detail) VALUES (_device,'unlock.finished',
      jsonb_build_object('request_id',a.id,'os_unlocked',_body->'osUnlocked'='true'::jsonb));
    RETURN jsonb_build_object('ended',true);
  END IF;
  RAISE EXCEPTION 'invalid_unlock_request';
END;
$$;

CREATE FUNCTION public.unlock_removal_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.devices%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.devices WHERE id=OLD.device_id;
  IF FOUND AND d.metadata->>'token_hash' ~ '^[0-9a-f]{64}$' THEN
    INSERT INTO public.device_unlock_revocations(device_identity,token_hash,key_id)
      VALUES (d.device_id,d.metadata->>'token_hash',OLD.key_id)
      ON CONFLICT (device_identity,key_id) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER unlock_permission_removal BEFORE DELETE ON public.device_unlock_permissions
  FOR EACH ROW EXECUTE FUNCTION public.unlock_removal_receipt();
-- Capture BEFORE the device disappears; its cascades cannot look it up later.
CREATE FUNCTION public.unlock_device_removal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.device_unlock_permissions WHERE device_id=OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER unlock_device_removal BEFORE DELETE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.unlock_device_removal();
CREATE FUNCTION public.unlock_grant_revoked()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    DELETE FROM public.device_unlock_permissions WHERE authorization_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER unlock_grant_revoked AFTER UPDATE OF revoked_at ON public.device_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.unlock_grant_revoked();

REVOKE ALL ON FUNCTION public.unlock_parent_allowed(uuid,uuid),public.unlock_device_status(uuid),
  public.unlock_admin(uuid,uuid,text,jsonb),public.unlock_agent(uuid,text,jsonb),
  public.unlock_removal_receipt(),public.unlock_device_removal(),public.unlock_grant_revoked()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_parent_allowed(uuid,uuid),public.unlock_device_status(uuid),
  public.unlock_admin(uuid,uuid,text,jsonb),public.unlock_agent(uuid,text,jsonb) TO service_role;
COMMIT;
