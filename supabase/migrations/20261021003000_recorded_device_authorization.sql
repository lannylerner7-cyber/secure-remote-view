-- SOURCE ONLY. Review/test in an isolated PostgreSQL/Supabase before application.
-- No historical authorization is backfilled. Presence/enrollment is not consent.
BEGIN;

CREATE FUNCTION public.valid_authorization_request(g jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(
    jsonb_typeof(g) = 'object'
    AND g ?& ARRAY['noticeVersion','mode','capabilities']
    AND (g - ARRAY['noticeVersion','mode','capabilities']) = '{}'::jsonb
    AND g->'noticeVersion' = '1'::jsonb
    AND g->>'mode' IN ('attended','unattended')
    AND jsonb_typeof(g->'capabilities') = 'object'
    AND (g->'capabilities') ?& ARRAY['view','control','clipboard','files','recording']
    AND ((g->'capabilities') - ARRAY['view','control','clipboard','files','recording']) = '{}'::jsonb
    AND jsonb_typeof(g->'capabilities'->'view') = 'boolean'
    AND jsonb_typeof(g->'capabilities'->'control') = 'boolean'
    AND jsonb_typeof(g->'capabilities'->'clipboard') = 'boolean'
    AND jsonb_typeof(g->'capabilities'->'files') = 'boolean'
    AND jsonb_typeof(g->'capabilities'->'recording') = 'boolean'
    AND (g->'capabilities'->'control' = 'false'::jsonb OR g->'capabilities'->'view' = 'true'::jsonb),
    false);
$$;

CREATE TABLE public.device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  -- Identity attested by the authenticated endpoint, not an invented human name.
  authorizing_person jsonb NOT NULL,
  notice_version integer NOT NULL CHECK (notice_version = 1),
  mode text NOT NULL CHECK (mode IN ('attended','unattended')),
  capabilities jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK (public.valid_authorization_request(jsonb_build_object(
    'noticeVersion',notice_version,'mode',mode,'capabilities',capabilities)))
);
CREATE UNIQUE INDEX one_current_device_authorization
  ON public.device_authorizations(device_id) WHERE revoked_at IS NULL;
ALTER TABLE public.device_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_authorizations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.device_authorizations TO service_role;

ALTER TABLE public.sessions
  ADD COLUMN authorization_id uuid REFERENCES public.device_authorizations(id),
  ADD COLUMN authorization_mode text CHECK (authorization_mode IN ('attended','unattended'));

CREATE FUNCTION public.device_authorization(_device_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id',a.id,'noticeVersion',a.notice_version,'mode',a.mode,
    'capabilities',a.capabilities,'recordedAt',a.recorded_at,'revokedAt',a.revoked_at)
  FROM public.device_authorizations a
  WHERE a.device_id = _device_id
  ORDER BY a.recorded_at DESC, a.id DESC LIMIT 1;
$$;

CREATE FUNCTION public.revoke_device_authorization(_device_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM public.devices WHERE id = _device_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'device_not_found'; END IF;
  UPDATE public.device_authorizations SET revoked_at = clock_timestamp()
    WHERE device_id = _device_id AND revoked_at IS NULL;
  UPDATE public.sessions SET state = 'ended', ended_at = clock_timestamp()
    WHERE device_id = _device_id AND state NOT IN ('ended','declined');
  DELETE FROM public.session_frames WHERE session_id IN (SELECT id FROM public.sessions WHERE device_id = _device_id);
  DELETE FROM public.session_cursors WHERE session_id IN (SELECT id FROM public.sessions WHERE device_id = _device_id);
  DELETE FROM public.session_signals WHERE session_id IN (SELECT id FROM public.sessions WHERE device_id = _device_id);
  DELETE FROM public.session_inputs WHERE session_id IN (SELECT id FROM public.sessions WHERE device_id = _device_id)
    AND kind NOT IN ('release_inputs','curtain_off');
END;
$$;

CREATE FUNCTION public.record_device_authorization(_device_id uuid, _grant jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  owner uuid;
  external_device_id text;
BEGIN
  IF NOT public.valid_authorization_request(_grant) THEN
    RAISE EXCEPTION 'invalid_authorization' USING ERRCODE = '22023';
  END IF;
  -- Serialize replacement/revocation for one endpoint; end all prior invitations too.
  PERFORM public.revoke_device_authorization(_device_id);
  SELECT l.user_id, d.device_id INTO owner, external_device_id
    FROM public.devices d LEFT JOIN public.licenses l ON l.id = d.license_id WHERE d.id = _device_id;
  IF owner IS NULL THEN
    RAISE EXCEPTION 'authorization_owner_required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.device_authorizations(device_id,owner_id,authorizing_person,notice_version,mode,capabilities)
    VALUES (_device_id,owner,jsonb_build_object('source','authenticated_local_endpoint',
      'deviceId',external_device_id),1,_grant->>'mode',_grant->'capabilities');
  RETURN public.device_authorization(_device_id);
END;
$$;

CREATE FUNCTION public.session_authorized(_session_id uuid, _capability text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM public.sessions s
    JOIN public.devices d ON d.id = s.device_id
    LEFT JOIN public.licenses l ON l.id = d.license_id
    JOIN public.device_authorizations a ON a.id = s.authorization_id AND a.device_id = s.device_id
    WHERE s.id = _session_id AND s.state = 'active'
      AND s.mode IN ('view','control') AND s.consent_at IS NOT NULL
      AND s.authorization_mode = a.mode
      AND a.notice_version = 1 AND a.revoked_at IS NULL
      AND a.owner_id IS NOT DISTINCT FROM l.user_id
      AND public.valid_authorization_request(jsonb_build_object(
        'noticeVersion',a.notice_version,'mode',a.mode,'capabilities',a.capabilities))
      AND a.capabilities->'view' = 'true'::jsonb
      AND (s.mode <> 'control' OR a.capabilities->'control' = 'true'::jsonb)
      AND _capability IN ('view','control','clipboard','files','recording')
      AND a.capabilities->_capability = 'true'::jsonb
      AND (_capability <> 'control' OR s.mode = 'control')
      AND (auth.role() = 'service_role' OR s.technician_id = auth.uid()
        OR public.has_role(auth.uid(),'super_admin'))
  ),false);
$$;

REVOKE ALL ON FUNCTION public.device_authorization(uuid),
  public.record_device_authorization(uuid,jsonb),
  public.revoke_device_authorization(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.device_authorization(uuid),
  public.record_device_authorization(uuid,jsonb),
  public.revoke_device_authorization(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.session_authorized(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_authorized(uuid,text) TO authenticated, service_role;

-- Applies to service-role handlers as well as direct JWT writes/RPCs.
CREATE FUNCTION public.guard_recorded_session_authority()
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
      RAISE EXCEPTION 'new_local_session_authorization_required' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.state <> 'invited' OR NEW.authorization_id IS NOT NULL OR NEW.authorization_mode IS NOT NULL OR NEW.consent_at IS NOT NULL THEN
      RAISE EXCEPTION 'invitation_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.mode NOT IN ('view','control') THEN RAISE EXCEPTION 'invalid_session_mode'; END IF;
  -- End/pause/decline and clearing peer binding must work even after withdrawal.
  IF NEW.state = 'active' THEN
    PERFORM 1 FROM public.devices WHERE id = NEW.device_id FOR UPDATE;
    SELECT l.user_id INTO owner FROM public.devices d LEFT JOIN public.licenses l ON l.id = d.license_id WHERE d.id = NEW.device_id;
    SELECT * INTO a FROM public.device_authorizations WHERE id = NEW.authorization_id;
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
CREATE TRIGGER guard_recorded_session_authority BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_recorded_session_authority();

CREATE FUNCTION public.input_capability(_kind text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _kind IN ('release_inputs','curtain_off') THEN 'safety'
    WHEN _kind IN ('restart_stream','switch_monitor') THEN 'view'
    WHEN _kind = 'clipboard' THEN 'clipboard'
    WHEN _kind IN ('mousemove','mousemove_rel','mousedown','mouseup','wheel','click',
      'keydown','keyup','unicode_text','key_sequence','curtain_on') THEN 'control'
    ELSE NULL END;
$$;

CREATE FUNCTION public.session_safety_access(_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = _session_id AND
    (auth.role() = 'service_role' OR s.technician_id = auth.uid() OR public.has_role(auth.uid(),'super_admin')));
$$;
REVOKE ALL ON FUNCTION public.session_safety_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_safety_access(uuid) TO authenticated, service_role;

CREATE FUNCTION public.guard_live_channel_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cap text := 'view';
BEGIN
  IF TG_TABLE_NAME = 'session_inputs' THEN
    cap := public.input_capability(NEW.kind);
    IF cap = 'safety' AND public.session_safety_access(NEW.session_id) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME IN ('session_files','session_secrets') THEN
    cap := 'files';
  END IF;
  -- Serialize against consent, end and revocation. No channel-write TOCTOU
  -- bypass even when the HTTP preflight ran before withdrawal.
  PERFORM 1 FROM public.devices WHERE id = (SELECT device_id FROM public.sessions WHERE id = NEW.session_id) FOR SHARE;
  IF TG_TABLE_NAME = 'session_files' THEN
    -- Serialize quota admission for concurrent manifest writers as well as
    -- revocation. The service storage write is separate; orphan bytes are not
    -- a published manifest and are never returned by the download proxy.
    PERFORM 1 FROM public.sessions WHERE id = NEW.session_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.sessions WHERE id = NEW.session_id FOR SHARE;
  END IF;
  IF cap IS NULL OR NOT public.session_authorized(NEW.session_id,cap) THEN
    RAISE EXCEPTION 'channel_authorization_required' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'session_files' THEN
    IF NEW.storage_path !~ ('^' || NEW.session_id::text || '/[A-Za-z0-9_-]+-[A-Za-z0-9._ -]{1,180}$') THEN
      RAISE EXCEPTION 'invalid_file_path' USING ERRCODE = '22023';
    END IF;
    IF NEW.size_bytes < 0 OR NEW.size_bytes > 524288000 THEN
      RAISE EXCEPTION 'file_too_large' USING ERRCODE = '22023';
    END IF;
    IF NEW.deleted_at IS NULL AND
       (SELECT COALESCE(sum(f.size_bytes),0) FROM public.session_files f
        WHERE f.session_id = NEW.session_id AND f.deleted_at IS NULL AND f.id <> NEW.id)
        + NEW.size_bytes > 5368709120 THEN
      RAISE EXCEPTION 'session_quota_exceeded' USING ERRCODE = '22023';
    END IF;
    IF NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM public.session_files f
       WHERE f.storage_path = NEW.storage_path AND f.id <> NEW.id AND f.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'file_already_registered' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['session_frames','session_cursors','session_signals','session_inputs','session_files','session_secrets'] LOOP
    EXECUTE format('CREATE TRIGGER guard_live_channel_write BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_live_channel_write()',t);
  END LOOP;
END;
$$;

-- Restrictive policies AND with *all* historical permissive owner/staff policies.
-- Never rely on dropping just the latest permissive policy.
CREATE POLICY recorded_frames ON public.session_frames AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.session_authorized(session_id,'view')) WITH CHECK (public.session_authorized(session_id,'view'));
CREATE POLICY recorded_cursors ON public.session_cursors AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.session_authorized(session_id,'view')) WITH CHECK (public.session_authorized(session_id,'view'));
CREATE POLICY recorded_signals ON public.session_signals AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.session_authorized(session_id,'view')) WITH CHECK (public.session_authorized(session_id,'view'));
CREATE POLICY recorded_files ON public.session_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.session_authorized(session_id,'files')) WITH CHECK (public.session_authorized(session_id,'files'));
CREATE POLICY recorded_inputs ON public.session_inputs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((public.input_capability(kind) = 'safety' AND public.session_safety_access(session_id))
    OR public.session_authorized(session_id,public.input_capability(kind)))
  WITH CHECK ((public.input_capability(kind) = 'safety' AND public.session_safety_access(session_id))
    OR public.session_authorized(session_id,public.input_capability(kind)));

CREATE FUNCTION public.storage_session_authorized(_path text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE sid text := split_part(_path,'/',1);
BEGIN
  IF sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  RETURN public.session_authorized(sid::uuid,'files');
END;
$$;
REVOKE ALL ON FUNCTION public.storage_session_authorized(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.storage_session_authorized(text) TO authenticated, service_role;
CREATE POLICY recorded_storage ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  -- Storage SELECT also permits minting irrevocable signed download URLs.
  -- Deny direct client access to this bucket, not just URL issuance in wrappers.
  -- Authenticated per-request proxies/device HTTP uploads use service role.
  USING (bucket_id <> 'session-files')
  WITH CHECK (bucket_id <> 'session-files');

-- A database technician must not forge a device token in mutable metadata and
-- then use the device-only grant-recording endpoint to impersonate local consent.
CREATE FUNCTION public.guard_device_credentials()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.metadata ? 'token_hash' THEN
        RAISE EXCEPTION 'device_credentials_server_managed' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.device_id IS DISTINCT FROM OLD.device_id
       OR (NEW.metadata->'token_hash') IS DISTINCT FROM (OLD.metadata->'token_hash') THEN
      RAISE EXCEPTION 'device_credentials_server_managed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_device_credentials BEFORE INSERT OR UPDATE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.guard_device_credentials();

-- A session row's cached presence flag is not authority. The heartbeat performs
-- its own grant checks; no device column can reactivate capture.
COMMIT;
