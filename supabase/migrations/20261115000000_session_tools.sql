-- Prepared only. Apply separately after approval; tests use disposable PostgreSQL.
BEGIN;
CREATE TABLE public.session_file_receipts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL REFERENCES public.device_authorizations(id) ON DELETE CASCADE,
  controller_id text NOT NULL,
  peer_id text NOT NULL,
  agent_instance uuid,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 524288000),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  direction text CHECK (direction IN ('from_agent','from_admin')),
  storage_path text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','delivered','complete')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
ALTER TABLE public.session_file_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_file_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.session_file_receipts TO service_role;
CREATE INDEX session_file_receipts_session ON public.session_file_receipts(session_id);

CREATE FUNCTION public.reserve_session_file(_session uuid, _id uuid, _size bigint, _sha text,
  _name text, _direction text, _controller text, _peer text, _instance uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions; r public.session_file_receipts; used bigint;
BEGIN
  -- One transaction serializes both directions and all transports for this session.
  SELECT * INTO s FROM public.sessions WHERE id=_session FOR UPDATE;
  IF NOT FOUND OR NOT public.session_authorized(s.id,'files') OR _controller IS NULL OR _controller='' OR
    NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=s.technician_id AND
      ur.role IN ('super_admin','admin','technician')) OR
    COALESCE(s.admin_client_id::text,'')<>_controller THEN RAISE EXCEPTION 'file_authorization_changed'; END IF;
  IF _id IS NULL OR _size IS NULL OR _size NOT BETWEEN 0 AND 524288000 OR _sha IS NULL OR
    (_sha<>'' AND _sha !~ '^[a-f0-9]{64}$') OR _name IS NULL OR
    _name !~ '^[A-Za-z0-9._ -]{1,180}$' OR _direction IS NULL OR _direction NOT IN ('','from_agent','from_admin') OR
    _peer IS NULL OR length(_peer)>64 THEN RAISE EXCEPTION 'invalid_file_metadata'; END IF;
  -- A supplied peer must be the newest offer from the current controller.
  IF _peer<>'' AND _peer IS DISTINCT FROM
    (SELECT payload->>'peer_id' FROM public.session_signals WHERE session_id=s.id AND
      from_side='admin' AND kind='offer' AND admin_client_id::text=_controller ORDER BY id DESC LIMIT 1)
    THEN RAISE EXCEPTION 'file_peer_changed'; END IF;
  SELECT * INTO r FROM public.session_file_receipts WHERE id=_id;
  IF COALESCE(r.agent_instance,_instance) IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM public.agent_runtime ar WHERE ar.device_id=s.device_id AND
      ar.agent_instance=COALESCE(r.agent_instance,_instance) AND ar.agent_state='running')
    THEN RAISE EXCEPTION 'file_process_changed'; END IF;
  IF r.id IS NOT NULL THEN
    IF r.session_id<>s.id OR r.authorization_id<>s.authorization_id OR r.controller_id<>_controller OR
      r.peer_id<>_peer OR r.size_bytes<>_size OR (r.sha256 IS NOT NULL AND r.sha256 IS DISTINCT FROM NULLIF(_sha,'')) OR
      r.name<>_name OR (_instance IS NOT NULL AND r.agent_instance IS DISTINCT FROM _instance) OR
      (r.direction IS NOT NULL AND r.direction IS DISTINCT FROM NULLIF(_direction,''))
      THEN RAISE EXCEPTION 'file_identity_conflict'; END IF;
    -- Native Admin's unchanged two-phase DTO supplies its checksum at register.
    -- An incomplete intent can never become a manifest. Seal once, never replace.
    UPDATE public.session_file_receipts SET sha256=COALESCE(sha256,NULLIF(_sha,'')),
      direction=COALESCE(direction,NULLIF(_direction,'')) WHERE id=r.id;
    RETURN jsonb_build_object('state',r.state,'path',r.storage_path,'id',r.id);
  END IF;
  SELECT COALESCE(sum(size_bytes),0) INTO used FROM public.session_files WHERE session_id=s.id;
  SELECT used+COALESCE(sum(rf.size_bytes),0) INTO used FROM public.session_file_receipts rf
    WHERE rf.session_id=s.id AND NOT EXISTS
      (SELECT 1 FROM public.session_files f WHERE f.session_id=s.id AND f.storage_path=rf.storage_path);
  IF used+_size>5368709120 THEN RAISE EXCEPTION 'session_quota_exceeded'; END IF;
  IF (SELECT count(*) FROM public.session_file_receipts WHERE session_id=s.id)>=512
    THEN RAISE EXCEPTION 'session_transfer_limit'; END IF;
  INSERT INTO public.session_file_receipts(id,session_id,authorization_id,controller_id,peer_id,
    size_bytes,sha256,name,direction,storage_path,agent_instance)
    VALUES(_id,s.id,s.authorization_id,_controller,_peer,_size,NULLIF(_sha,''),_name,NULLIF(_direction,''),
      s.id::text||'/'||_id::text||'-'||_name,_instance) RETURNING * INTO r;
  RETURN jsonb_build_object('state',r.state,'path',r.storage_path,'id',r.id);
END; $$;

CREATE FUNCTION public.complete_session_file(_session uuid,_id uuid,_controller text,_peer text,
  _mime text,_transport text,_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions; r public.session_file_receipts; fid uuid;
BEGIN
  SELECT * INTO s FROM public.sessions WHERE id=_session FOR UPDATE;
  SELECT * INTO r FROM public.session_file_receipts WHERE id=_id AND session_id=_session FOR UPDATE;
  IF s.id IS NULL OR r.id IS NULL OR _controller IS NULL OR _controller='' OR _peer IS NULL OR
    NOT public.session_authorized(s.id,'files') OR
    NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=s.technician_id AND
      ur.role IN ('super_admin','admin','technician')) OR
    (r.agent_instance IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.agent_runtime ar WHERE
      ar.device_id=s.device_id AND ar.agent_instance=r.agent_instance AND ar.agent_state='running')) OR
    s.authorization_id IS DISTINCT FROM r.authorization_id OR
    COALESCE(s.admin_client_id::text,'')<>_controller OR r.controller_id<>_controller OR r.peer_id<>_peer OR
    (_peer<>'' AND _peer IS DISTINCT FROM (SELECT payload->>'peer_id' FROM public.session_signals
      WHERE session_id=s.id AND from_side='admin' AND kind='offer' AND admin_client_id::text=_controller
      ORDER BY id DESC LIMIT 1)) THEN RAISE EXCEPTION 'file_authorization_changed'; END IF;
  IF r.sha256 IS NULL OR r.direction IS NULL OR _transport IS NULL OR _transport NOT IN ('http','datachannel') OR
    _mime IS NULL OR length(_mime)>128 THEN RAISE EXCEPTION 'invalid_file_metadata'; END IF;
  IF r.state='complete' THEN RETURN jsonb_build_object('ok',true,'id',r.id,'state','complete','path',r.storage_path); END IF;
  INSERT INTO public.session_files(id,session_id,name,size_bytes,sha256,storage_path,direction,mime,transport,uploaded_by)
    VALUES(r.id,s.id,r.name,r.size_bytes,r.sha256,r.storage_path,r.direction,_mime,_transport,_actor);
  UPDATE public.session_file_receipts SET state='complete',completed_at=clock_timestamp() WHERE id=r.id;
  RETURN jsonb_build_object('ok',true,'id',r.id,'state','complete','path',r.storage_path);
END; $$;
REVOKE ALL ON FUNCTION public.reserve_session_file(uuid,uuid,bigint,text,text,text,text,text,uuid),
  public.complete_session_file(uuid,uuid,text,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_session_file(uuid,uuid,bigint,text,text,text,text,text,uuid),
  public.complete_session_file(uuid,uuid,text,text,text,text,uuid) TO service_role;

-- A verified direct transfer is history/quota, NOT an archived object manifest.
CREATE FUNCTION public.confirm_direct_session_file(_session uuid,_id uuid,_size bigint,_sha text,_controller text,_peer text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.session_file_receipts;
BEGIN
  SELECT * INTO r FROM public.session_file_receipts WHERE id=_id AND session_id=_session;
  IF NOT FOUND OR r.sha256 IS NULL OR r.direction IS NULL OR r.size_bytes IS DISTINCT FROM _size OR r.sha256 IS DISTINCT FROM _sha
    THEN RAISE EXCEPTION 'unconfirmed_direct_file'; END IF;
  PERFORM public.reserve_session_file(_session,_id,r.size_bytes,r.sha256,r.name,r.direction,_controller,_peer,r.agent_instance);
  UPDATE public.session_file_receipts SET state=CASE WHEN state='complete' THEN state ELSE 'delivered' END,
    completed_at=clock_timestamp() WHERE id=_id;
  RETURN jsonb_build_object('state','delivered','id',_id,'size',r.size_bytes,'sha256',r.sha256);
END; $$;
REVOKE ALL ON FUNCTION public.confirm_direct_session_file(uuid,uuid,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_direct_session_file(uuid,uuid,bigint,text,text,text) TO service_role;

-- Local owner entry reuses the existing vault and device-bound envelope.
-- NULL distinguishes device-owner entry from an administrator user account.
ALTER TABLE public.device_unlock_credentials ALTER COLUMN saved_by DROP NOT NULL;
CREATE FUNCTION public.save_owner_unlock_pin(_device uuid,_key uuid,_envelope jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.device_unlock_permissions;
BEGIN
  PERFORM 1 FROM public.devices WHERE id=_device FOR UPDATE;
  SELECT * INTO p FROM public.device_unlock_permissions WHERE device_id=_device AND key_id=_key;
  IF NOT FOUND OR NOT public.unlock_parent_allowed(_device,p.authorization_id) OR
    NOT p.helper_ready OR p.seen_at IS NULL OR p.seen_at<clock_timestamp()-interval '15 seconds'
    THEN RAISE EXCEPTION 'unlock_setup_required'; END IF;
  IF _envelope IS NULL OR jsonb_typeof(_envelope)<>'object' OR
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(_envelope) k)
      IS DISTINCT FROM ARRAY['algorithm','ciphertext','iv','keyId','version','wrappedKey'] OR
    _envelope->>'keyId' IS DISTINCT FROM _key::text OR _envelope->>'algorithm' IS DISTINCT FROM 'RSA-OAEP-256+A256GCM' OR
    _envelope->>'version' IS DISTINCT FROM '1' OR octet_length(_envelope::text)>4096 OR
    length(COALESCE(_envelope->>'wrappedKey',''))<>512 OR COALESCE(_envelope->>'wrappedKey','') !~ '^[A-Za-z0-9+/]+$' OR
    COALESCE(_envelope->>'iv','') !~ '^[A-Za-z0-9+/]{16}$' OR
    COALESCE(_envelope->>'ciphertext','') !~ '^[A-Za-z0-9+/=]{28,192}$'
    THEN RAISE EXCEPTION 'invalid_unlock_request'; END IF;
  INSERT INTO public.device_unlock_credentials(device_id,key_id,sealed_pin,saved_by)
    VALUES(_device,_key,_envelope,NULL) ON CONFLICT(device_id) DO UPDATE
    SET key_id=EXCLUDED.key_id,sealed_pin=EXCLUDED.sealed_pin,saved_by=NULL,
      saved_at=clock_timestamp(),credential_version=gen_random_uuid();
  UPDATE public.device_unlock_attempts SET ended_at=clock_timestamp() WHERE device_id=_device AND ended_at IS NULL;
  INSERT INTO public.audit_logs(device_id,event,detail) VALUES(_device,'unlock.owner_saved','{"version":1}');
  RETURN public.unlock_device_status(_device);
END; $$;
REVOKE ALL ON FUNCTION public.save_owner_unlock_pin(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_owner_unlock_pin(uuid,uuid,jsonb) TO service_role;
COMMIT;
