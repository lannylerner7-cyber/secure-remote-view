-- Additive browser-first enrollment. Does not authorize historical devices.
-- Apply through the existing migration runner, not application startup.
BEGIN;

CREATE TABLE public.device_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES public.licenses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  issued_by uuid NOT NULL REFERENCES auth.users(id),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  disclosure_id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization text NOT NULL CHECK (length(organization) BETWEEN 1 AND 120),
  grant_request jsonb NOT NULL CHECK (public.valid_authorization_request(grant_request)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  request_hash text,
  device_id uuid REFERENCES public.devices(id) ON DELETE SET NULL,
  authorization_id uuid REFERENCES public.device_authorizations(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX device_pairings_license ON public.device_pairings(license_id, expires_at);
ALTER TABLE public.device_pairings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_pairings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.device_pairings TO service_role;

CREATE TABLE public.pairing_attempts (
  bucket text PRIMARY KEY CHECK (length(bucket) <= 100),
  window_started timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  attempts integer NOT NULL
);
CREATE INDEX pairing_attempts_cleanup ON public.pairing_attempts(last_seen);
ALTER TABLE public.pairing_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pairing_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pairing_attempts TO service_role;

CREATE FUNCTION public.consume_pairing_attempt(_bucket text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF _bucket IS NULL OR length(_bucket) > 100 THEN RETURN false; END IF;
  INSERT INTO public.pairing_attempts(bucket,window_started,last_seen,attempts)
    VALUES (_bucket,clock_timestamp(),clock_timestamp(),1)
  ON CONFLICT (bucket) DO UPDATE SET
    attempts = CASE WHEN pairing_attempts.window_started < clock_timestamp() - interval '1 minute'
      THEN 1 ELSE LEAST(pairing_attempts.attempts + 1,1000000) END,
    window_started = CASE WHEN pairing_attempts.window_started < clock_timestamp() - interval '1 minute'
      THEN clock_timestamp() ELSE pairing_attempts.window_started END,
    last_seen = clock_timestamp()
  RETURNING attempts INTO n;
  DELETE FROM public.pairing_attempts WHERE bucket IN (
    SELECT bucket FROM public.pairing_attempts
    WHERE last_seen < clock_timestamp() - interval '1 day' LIMIT 100);
  RETURN n <= 30;
END;
$$;

CREATE FUNCTION public.create_device_pairing(_actor uuid, _license uuid, _code_hash text, _grant jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l public.licenses%ROWTYPE; p public.device_pairings%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.licenses WHERE id = _license FOR UPDATE;
  IF NOT FOUND OR _actor IS NULL OR
    (NOT COALESCE(public.has_role(_actor,'super_admin'),false) AND
      (l.user_id IS DISTINCT FROM _actor OR NOT COALESCE(public.has_role(_actor,'admin'),false)))
    THEN RAISE EXCEPTION 'pairing_forbidden' USING ERRCODE = '42501'; END IF;
  IF l.user_id IS NULL OR NULLIF(btrim(l.company),'') IS NULL OR length(btrim(l.company)) > 120
    THEN RAISE EXCEPTION 'pairing_identity_required'; END IF;
  IF l.status <> 'active' OR l.expires_at <= clock_timestamp() OR l.starts_at > clock_timestamp()
    THEN RAISE EXCEPTION 'pairing_license_inactive'; END IF;
  IF NOT public.valid_authorization_request(_grant) OR _grant->'capabilities'->'view' <> 'true'::jsonb
    OR _code_hash IS NULL OR _code_hash !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid_pairing'; END IF;
  IF (SELECT count(*) FROM public.device_pairings WHERE license_id = _license
    AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()) >= 5
    THEN RAISE EXCEPTION 'pairing_limit_reached'; END IF;
  INSERT INTO public.device_pairings(license_id,owner_id,issued_by,code_hash,organization,grant_request,expires_at)
    VALUES (_license,l.user_id,_actor,_code_hash,btrim(l.company),_grant,clock_timestamp()+interval '10 minutes')
    RETURNING * INTO p;
  INSERT INTO public.audit_logs(event,detail)
    VALUES ('device.pairing_issued',jsonb_build_object('pairing_id',p.id,'license_id',_license,'actor',_actor));
  RETURN jsonb_build_object('id',p.id,'disclosureId',p.disclosure_id,'organization',p.organization,
    'expiresAt',p.expires_at,'grant',p.grant_request);
END;
$$;

CREATE FUNCTION public.inspect_device_pairing(_code_hash text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id',p.id,'disclosureId',p.disclosure_id,'organization',p.organization,
    'expiresAt',p.expires_at,'grant',p.grant_request)
  FROM public.device_pairings p JOIN public.licenses l ON l.id = p.license_id
  WHERE p.code_hash = _code_hash AND p.consumed_at IS NULL AND p.revoked_at IS NULL
    AND p.expires_at > clock_timestamp() AND l.status = 'active'
    AND l.expires_at > clock_timestamp() AND l.starts_at <= clock_timestamp()
    AND l.user_id = p.owner_id AND btrim(l.company) = p.organization
    AND ((p.issued_by = l.user_id AND public.has_role(p.issued_by,'admin'))
      OR public.has_role(p.issued_by,'super_admin'));
$$;

CREATE FUNCTION public.redeem_device_pairing(
  _code_hash text, _request_hash text, _token_hash text, _disclosure_id uuid,
  _hostname text, _os text, _agent_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.device_pairings%ROWTYPE; l public.licenses%ROWTYPE;
  d uuid; a jsonb; stored_hash text;
BEGIN
  IF _request_hash IS NULL OR _request_hash !~ '^[0-9a-f]{64}$' OR
    _token_hash IS NULL OR _token_hash !~ '^[0-9a-f]{64}$' OR
    _hostname IS NULL OR length(_hostname) NOT BETWEEN 1 AND 200 OR
    _os IS NULL OR length(_os) > 200 OR _agent_version IS NULL OR length(_agent_version) > 40
    THEN RAISE EXCEPTION 'invalid_pairing'; END IF;
  -- One code can create at most one device even under concurrent redemptions.
  SELECT * INTO p FROM public.device_pairings WHERE code_hash = _code_hash FOR UPDATE;
  IF NOT FOUND OR p.revoked_at IS NOT NULL OR p.expires_at <= clock_timestamp()
    OR p.disclosure_id IS DISTINCT FROM _disclosure_id THEN RAISE EXCEPTION 'pairing_unavailable'; END IF;
  SELECT * INTO l FROM public.licenses WHERE id = p.license_id FOR UPDATE;
  IF NOT FOUND OR l.user_id IS DISTINCT FROM p.owner_id OR l.status <> 'active' OR
    l.expires_at <= clock_timestamp() OR l.starts_at > clock_timestamp() OR
    btrim(l.company) IS DISTINCT FROM p.organization OR
    (NOT COALESCE(public.has_role(p.issued_by,'super_admin'),false) AND
      (p.issued_by IS DISTINCT FROM l.user_id OR NOT COALESCE(public.has_role(p.issued_by,'admin'),false)))
    THEN RAISE EXCEPTION 'pairing_unavailable'; END IF;
  IF p.consumed_at IS NOT NULL THEN
    -- A lost HTTP response can be retried only by the same attempt and token.
    SELECT metadata->>'token_hash' INTO stored_hash FROM public.devices WHERE id = p.device_id;
    a := public.device_authorization(p.device_id);
    IF p.request_hash IS DISTINCT FROM _request_hash OR stored_hash IS DISTINCT FROM _token_hash
      OR a IS NULL OR a->>'id' IS DISTINCT FROM p.authorization_id::text
      OR a->'revokedAt' <> 'null'::jsonb THEN RAISE EXCEPTION 'pairing_unavailable'; END IF;
    RETURN jsonb_build_object('deviceId',p.device_id,'authorization',a);
  END IF;
  -- License-row locking serializes new pairing redemptions for the seat check.
  IF (SELECT count(*) FROM public.devices WHERE license_id = l.id) >= l.seat_limit
    THEN RAISE EXCEPTION 'pairing_seats_full'; END IF;
  -- The gateway authenticates x-device-id against devices.device_id, not id.
  -- New pairings use the same UUID for both identities; legacy rows are untouched.
  d := gen_random_uuid();
  INSERT INTO public.devices(id,device_id,display_name,hostname,os,platform,status,last_seen_at,
    license_id,license_state,metadata)
    VALUES (d,d::text,_hostname,_hostname,_os,'windows','offline',
      NULL,l.id,'active',jsonb_build_object('token_hash',_token_hash,
        'enrolled_via','disclosed_pairing','agent_version',_agent_version,'browser_video',1))
    ;
  a := public.record_device_authorization(d,p.grant_request);
  UPDATE public.device_pairings SET consumed_at = clock_timestamp(),request_hash = _request_hash,
    device_id = d,authorization_id = (a->>'id')::uuid WHERE id = p.id;
  INSERT INTO public.audit_logs(device_id,event,detail)
    VALUES (d,'device.paired',jsonb_build_object('pairing_id',p.id,'license_id',l.id,
      'disclosure_id',p.disclosure_id,'notice_version',1));
  RETURN jsonb_build_object('deviceId',d,'authorization',a);
END;
$$;

CREATE FUNCTION public.revoke_device_pairing(_actor uuid, _pairing_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.device_pairings%ROWTYPE; owner uuid;
BEGIN
  SELECT * INTO p FROM public.device_pairings WHERE id = _pairing_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT user_id INTO owner FROM public.licenses WHERE id = p.license_id;
  IF _actor IS NULL OR (owner IS DISTINCT FROM _actor AND
    NOT COALESCE(public.has_role(_actor,'super_admin'),false))
    THEN RAISE EXCEPTION 'pairing_forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.device_pairings SET revoked_at = clock_timestamp() WHERE id = p.id;
  -- Revoke an issued code independently. Already-enrolled devices use the
  -- existing device authorization revocation path; don't conflate the two.
  INSERT INTO public.audit_logs(event,detail)
    VALUES ('device.pairing_revoked',jsonb_build_object('pairing_id',p.id,'actor',_actor));
  RETURN true;
END;
$$;

CREATE FUNCTION public.revoke_managed_device_access(_actor uuid, _device_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owner uuid;
BEGIN
  SELECT l.user_id INTO owner FROM public.devices d
    JOIN public.licenses l ON l.id = d.license_id WHERE d.id = _device_id FOR UPDATE OF d;
  IF NOT FOUND OR _actor IS NULL OR (owner IS DISTINCT FROM _actor AND
    NOT COALESCE(public.has_role(_actor,'super_admin'),false))
    THEN RAISE EXCEPTION 'pairing_forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM public.revoke_device_authorization(_device_id);
  INSERT INTO public.audit_logs(device_id,event,detail)
    VALUES (_device_id,'device.access_revoked',jsonb_build_object('actor',_actor));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_pairing_attempt(text),
  public.create_device_pairing(uuid,uuid,text,jsonb),public.inspect_device_pairing(text),
  public.redeem_device_pairing(text,text,text,uuid,text,text,text),
  public.revoke_device_pairing(uuid,uuid),public.revoke_managed_device_access(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_pairing_attempt(text),
  public.create_device_pairing(uuid,uuid,text,jsonb),public.inspect_device_pairing(text),
  public.redeem_device_pairing(text,text,text,uuid,text,text,text),
  public.revoke_device_pairing(uuid,uuid),public.revoke_managed_device_access(uuid,uuid) TO service_role;
COMMIT;
