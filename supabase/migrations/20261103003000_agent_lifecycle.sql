-- Additive lifecycle contract. Apply with the reviewed migration runner before
-- deploying the new web/Agent pair. No existing devices or grants are recreated.
BEGIN;
CREATE TABLE public.agent_runtime (
  device_id uuid PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  agent_instance uuid,
  agent_sequence bigint NOT NULL DEFAULT 0 CHECK (agent_sequence >= 0),
  agent_seen_at timestamptz,
  heartbeat_seconds integer NOT NULL DEFAULT 60 CHECK (heartbeat_seconds BETWEEN 5 AND 60),
  agent_state text NOT NULL DEFAULT 'unknown'
    CHECK (agent_state IN ('unknown','running','stopped','starting','failed','disabled','uninstalling')),
  watch_instance uuid,
  watch_sequence bigint NOT NULL DEFAULT 0 CHECK (watch_sequence >= 0),
  watch_seen_at timestamptz,
  authorization_id uuid,
  startup_enabled boolean NOT NULL DEFAULT false,
  detail_code text CHECK (detail_code ~ '^[a-z_]{1,64}$'),
  retired_agents uuid[] NOT NULL DEFAULT '{}',
  retired_watchers uuid[] NOT NULL DEFAULT '{}'
);
CREATE TABLE public.agent_lifecycle_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '2 minutes',
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','received','starting','healthy','already_running','failed','rejected','expired')),
  watch_instance uuid,
  detail_code text CHECK (detail_code ~ '^[a-z_]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_lifecycle_pending ON public.agent_lifecycle_commands(device_id, requested_at)
  WHERE state IN ('queued','received','starting');
CREATE INDEX agent_lifecycle_recent ON public.agent_lifecycle_commands(device_id, requested_at DESC);
ALTER TABLE public.agent_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_lifecycle_commands ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.can_manage_agent(_actor uuid, _device uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _actor IS NOT NULL
    AND (_actor = auth.uid() OR auth.role() = 'service_role') AND (
    COALESCE(public.has_role(_actor,'super_admin'),false) OR
    (COALESCE(public.has_role(_actor,'admin'),false) AND EXISTS (
      SELECT 1 FROM public.devices d JOIN public.licenses l ON l.id = d.license_id
      WHERE d.id = _device AND l.user_id = _actor
    ))
  );
$$;
REVOKE ALL ON FUNCTION public.can_manage_agent(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_agent(uuid,uuid) TO authenticated, service_role;
CREATE POLICY agent_runtime_read ON public.agent_runtime FOR SELECT TO authenticated
  USING (public.can_manage_agent(auth.uid(), device_id));
CREATE POLICY agent_commands_read ON public.agent_lifecycle_commands FOR SELECT TO authenticated
  USING (public.can_manage_agent(auth.uid(), device_id));
REVOKE ALL ON public.agent_runtime, public.agent_lifecycle_commands FROM anon, authenticated;
GRANT SELECT ON public.agent_runtime, public.agent_lifecycle_commands TO authenticated;
GRANT ALL ON public.agent_runtime, public.agent_lifecycle_commands TO service_role;

-- Agent heartbeats and Watch observations serialize on one row. Retired process
-- IDs prevent a delayed heartbeat from reviving a stopped/replaced instance.
CREATE FUNCTION public.record_agent_runtime(
  _device uuid, _instance uuid, _sequence bigint, _heartbeat_seconds integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.agent_runtime%ROWTYPE;
BEGIN
  IF _instance IS NULL OR _sequence IS NULL OR _sequence < 1 OR
    _heartbeat_seconds IS NULL OR _heartbeat_seconds NOT BETWEEN 5 AND 60 THEN
    RAISE EXCEPTION 'invalid_runtime_report';
  END IF;
  INSERT INTO public.agent_runtime(device_id) VALUES (_device) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.agent_runtime WHERE device_id = _device FOR UPDATE;
  IF _instance = ANY(r.retired_agents) THEN RETURN false; END IF;
  IF r.agent_instance = _instance AND _sequence = r.agent_sequence THEN RETURN r.agent_state = 'running'; END IF;
  IF r.agent_instance = _instance AND _sequence < r.agent_sequence THEN RETURN false; END IF;
  IF r.agent_instance IS NOT NULL AND r.agent_instance <> _instance THEN
    r.retired_agents := (ARRAY[r.agent_instance] || r.retired_agents)[1:32];
  END IF;
  UPDATE public.agent_runtime SET agent_instance = _instance, agent_sequence = _sequence,
    agent_seen_at = clock_timestamp(), heartbeat_seconds = _heartbeat_seconds,
    agent_state = 'running', detail_code = NULL, retired_agents = r.retired_agents
    WHERE device_id = _device;
  UPDATE public.devices SET status = 'online', last_seen_at = clock_timestamp(),
    metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('agent_runtime_protocol',1) WHERE id = _device;
  RETURN true;
END;
$$;

CREATE FUNCTION public.request_agent_relaunch(_actor uuid, _device uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.agent_runtime%ROWTYPE; g jsonb; c public.agent_lifecycle_commands%ROWTYPE;
BEGIN
  IF NOT public.can_manage_agent(_actor, _device) THEN RAISE EXCEPTION 'device_forbidden'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.devices WHERE id = _device AND platform = 'windows') THEN
    RAISE EXCEPTION 'windows_agent_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.devices WHERE id = _device AND metadata->>'agent_runtime_protocol' = '1') THEN
    RAISE EXCEPTION 'updated_agent_required';
  END IF;
  SELECT * INTO r FROM public.agent_runtime WHERE device_id = _device FOR UPDATE;
  g := public.device_authorization(_device);
  IF NOT FOUND OR NOT r.startup_enabled OR r.watch_seen_at < clock_timestamp() - interval '90 seconds'
    OR r.watch_seen_at IS NULL OR g IS NULL OR g->>'revokedAt' IS NOT NULL
    OR (g->>'id')::uuid IS DISTINCT FROM r.authorization_id THEN
    RAISE EXCEPTION 'authorized_watch_unavailable';
  END IF;
  UPDATE public.agent_lifecycle_commands SET state = 'expired', updated_at = clock_timestamp()
    WHERE device_id = _device AND state IN ('queued','received','starting') AND expires_at <= clock_timestamp();
  SELECT * INTO c FROM public.agent_lifecycle_commands
    WHERE device_id = _device AND state IN ('queued','received','starting')
      AND authorization_id = r.authorization_id AND expires_at > clock_timestamp()
    ORDER BY requested_at LIMIT 1;
  IF FOUND THEN RETURN to_jsonb(c); END IF;
  IF EXISTS (SELECT 1 FROM public.agent_lifecycle_commands WHERE device_id = _device
    AND requested_at > clock_timestamp() - interval '15 seconds') THEN
    RAISE EXCEPTION 'relaunch_rate_limited';
  END IF;
  INSERT INTO public.agent_lifecycle_commands(device_id,authorization_id,requested_by)
    VALUES (_device,r.authorization_id,_actor) RETURNING * INTO c;
  INSERT INTO public.audit_logs(device_id,event,detail)
    VALUES (_device,'agent.relaunch_requested',jsonb_build_object('actor',_actor,'command_id',c.id));
  RETURN to_jsonb(c);
END;
$$;

CREATE FUNCTION public.report_agent_watch(_device uuid, _report jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.agent_runtime%ROWTYPE;
  c public.agent_lifecycle_commands%ROWTYPE;
  g jsonb;
  instance uuid := (_report->>'instance')::uuid;
  seq bigint := (_report->>'sequence')::bigint;
  grant_id uuid := (_report->>'authorization_id')::uuid;
  observed uuid := (_report->>'agent_instance')::uuid;
  reported_state text := _report->>'state';
  code text := _report->>'detail_code';
  enabled boolean := COALESCE((_report->>'startup_enabled')::boolean,false);
  authorized boolean;
  receipt uuid := (_report->>'command_id')::uuid;
  result text := _report->>'command_state';
BEGIN
  IF instance IS NULL OR seq IS NULL OR seq < 1 OR reported_state IS NULL OR
    reported_state NOT IN ('running','stopped','starting','failed','disabled','uninstalling')
    OR (code IS NOT NULL AND code !~ '^[a-z_]{1,64}$') THEN
    RAISE EXCEPTION 'invalid_watch_report';
  END IF;
  INSERT INTO public.agent_runtime(device_id) VALUES (_device) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.agent_runtime WHERE device_id = _device FOR UPDATE;
  g := public.device_authorization(_device);
  authorized := enabled AND g IS NOT NULL AND g->>'revokedAt' IS NULL
    AND (g->>'id')::uuid = grant_id;
  -- An obsolete Watch cannot overwrite a replacement authorization's state.
  IF g IS NOT NULL AND g->>'revokedAt' IS NULL AND (g->>'id')::uuid IS DISTINCT FROM grant_id THEN
    RETURN jsonb_build_object('authorized',false,'error','authorization_changed');
  END IF;
  IF instance = ANY(r.retired_watchers) OR
    (r.watch_instance = instance AND seq <= r.watch_sequence) THEN
    RETURN jsonb_build_object('authorized',false,'error','stale_watch_report');
  END IF;
  IF r.watch_instance IS NOT NULL AND r.watch_instance <> instance THEN
    r.retired_watchers := (ARRAY[r.watch_instance] || r.retired_watchers)[1:32];
  END IF;
  -- A Watch report is NOT an Agent heartbeat; it cannot assert Agent health.
  IF reported_state IN ('stopped','disabled','uninstalling') AND observed IS NOT NULL THEN
    IF NOT observed = ANY(r.retired_agents) THEN
      r.retired_agents := (ARRAY[observed] || r.retired_agents)[1:32];
    END IF;
  END IF;
  IF (r.agent_instance IS NULL OR observed = r.agent_instance) AND reported_state <> 'running' THEN
    r.agent_state := reported_state;
    r.detail_code := code;
    UPDATE public.devices SET status = 'stopped' WHERE id = _device;
  END IF;
  UPDATE public.agent_runtime SET watch_instance = instance, watch_sequence = seq,
    watch_seen_at = clock_timestamp(), startup_enabled = COALESCE(authorized,false),
    authorization_id = grant_id, agent_state = r.agent_state, detail_code = r.detail_code,
    retired_agents = r.retired_agents, retired_watchers = r.retired_watchers WHERE device_id = _device;
  UPDATE public.agent_lifecycle_commands SET state = 'expired', updated_at = clock_timestamp()
    WHERE device_id = _device AND state IN ('queued','received','starting') AND expires_at <= clock_timestamp();
  IF NOT COALESCE(authorized,false) THEN
    UPDATE public.agent_lifecycle_commands SET state = 'rejected', detail_code = 'authorization_withdrawn',
      updated_at = clock_timestamp() WHERE device_id = _device AND state IN ('queued','received','starting');
    RETURN jsonb_build_object('authorized',false);
  END IF;
  IF receipt IS NOT NULL THEN
    SELECT * INTO c FROM public.agent_lifecycle_commands WHERE id = receipt AND device_id = _device FOR UPDATE;
    IF FOUND AND c.authorization_id = grant_id AND c.watch_instance = instance
      AND c.expires_at > clock_timestamp() AND c.state IN ('received','starting')
      AND result IN ('starting','healthy','already_running','failed','rejected') THEN
      IF result IN ('healthy','already_running') AND (
        observed IS DISTINCT FROM r.agent_instance OR r.agent_state <> 'running'
        OR r.agent_seen_at IS NULL OR r.agent_seen_at < clock_timestamp() - interval '75 seconds'
        OR (result = 'healthy' AND r.agent_seen_at < c.requested_at)
      ) THEN RAISE EXCEPTION 'agent_health_not_confirmed'; END IF;
      UPDATE public.agent_lifecycle_commands SET state = result, detail_code = code,
        updated_at = clock_timestamp() WHERE id = receipt;
    END IF;
  END IF;
  SELECT * INTO c FROM public.agent_lifecycle_commands
    WHERE device_id = _device AND authorization_id = grant_id AND expires_at > clock_timestamp()
      AND (state = 'queued' OR (state IN ('received','starting')
        AND (watch_instance = instance OR watch_instance = ANY(r.retired_watchers))))
    ORDER BY requested_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE public.agent_lifecycle_commands SET state = CASE WHEN state = 'queued' THEN 'received' ELSE state END,
      watch_instance = instance, updated_at = clock_timestamp() WHERE id = c.id RETURNING * INTO c;
    RETURN jsonb_build_object('authorized',true,'command',to_jsonb(c));
  END IF;
  RETURN jsonb_build_object('authorized',true);
END;
$$;
REVOKE ALL ON FUNCTION public.record_agent_runtime(uuid,uuid,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_agent_relaunch(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_agent_watch(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_agent_runtime(uuid,uuid,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_agent_relaunch(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_agent_watch(uuid,jsonb) TO service_role;
-- Wake notifications contain no credentials. The authenticated SSE gateway
-- fans them out; durable commands are still read/claimed through the RPC.
DO $$
DECLARE item text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND NOT puballtables) THEN
    FOREACH item IN ARRAY ARRAY['agent_lifecycle_commands','sessions','power_commands'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public' AND tablename = item) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', item);
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
