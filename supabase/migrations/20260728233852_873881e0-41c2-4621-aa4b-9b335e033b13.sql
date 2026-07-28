-- 1. Admin heartbeat column
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS admin_bound_at timestamptz;

-- 2. Idempotent signal retries
ALTER TABLE public.session_signals
  ADD COLUMN IF NOT EXISTS attempt_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_session_signals_attempt
  ON public.session_signals (session_id, attempt_id)
  WHERE attempt_id IS NOT NULL;

-- 3. bind_admin RPC — claim / refresh / take-over
CREATE OR REPLACE FUNCTION public.bind_admin(
  _session_id uuid,
  _client_id  text
) RETURNS TABLE (
  bound         boolean,
  admin_client_id text,
  reason        text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.sessions%ROWTYPE;
  stale_after interval := interval '45 seconds';
BEGIN
  IF _client_id IS NULL OR length(_client_id) < 8 OR length(_client_id) > 64 THEN
    RETURN QUERY SELECT false, NULL::text, 'invalid_client_id'::text;
    RETURN;
  END IF;

  SELECT * INTO s FROM public.sessions WHERE id = _session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, 'not_found'::text;
    RETURN;
  END IF;

  IF s.state NOT IN ('invited','consented','active','paused') THEN
    RETURN QUERY SELECT false, s.admin_client_id, 'not_active'::text;
    RETURN;
  END IF;

  -- Own it: current binding is NULL, matches, or is older than stale_after.
  IF s.admin_client_id IS NULL
     OR s.admin_client_id = _client_id
     OR s.admin_bound_at IS NULL
     OR s.admin_bound_at < now() - stale_after
  THEN
    UPDATE public.sessions
       SET admin_client_id = _client_id,
           admin_bound_at  = now()
     WHERE id = _session_id;
    RETURN QUERY SELECT true, _client_id, 'ok'::text;
    RETURN;
  END IF;

  -- Someone else holds it and is still heartbeating.
  RETURN QUERY SELECT false, s.admin_client_id, 'superseded'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.bind_admin(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_admin(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bind_admin(uuid, text) TO service_role;

-- 4. Extend prune to auto-release stale admin bindings
CREATE OR REPLACE FUNCTION public.prune_session_ephemera()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.session_inputs  WHERE created_at < now() - interval '10 minutes';
  DELETE FROM public.session_signals WHERE created_at < now() - interval '10 minutes';

  DELETE FROM public.session_frames f
    USING public.sessions s
   WHERE f.session_id = s.id
     AND s.state = 'ended'
     AND s.ended_at < now() - interval '5 minutes';

  DELETE FROM public.session_cursors c
    USING public.sessions s
   WHERE c.session_id = s.id
     AND s.state = 'ended'
     AND s.ended_at < now() - interval '5 minutes';

  DELETE FROM public.session_frames
   WHERE updated_at < now() - interval '1 hour'
     AND session_id NOT IN (SELECT id FROM public.sessions);
  DELETE FROM public.session_cursors
   WHERE updated_at < now() - interval '1 hour'
     AND session_id NOT IN (SELECT id FROM public.sessions);

  DELETE FROM public.audit_logs WHERE created_at < now() - interval '90 days';

  DELETE FROM public.login_attempts
   WHERE (locked_until IS NULL AND updated_at < now() - interval '1 day')
      OR (locked_until IS NOT NULL AND locked_until < now() - interval '1 day');

  DELETE FROM public.notifications
   WHERE created_at < now() - interval '30 days'
     AND (read_at IS NOT NULL OR recipient_id IS NULL);

  UPDATE public.power_commands
     SET state = 'expired'
   WHERE state IN ('queued','dispatched')
     AND expires_at < now();

  DELETE FROM public.power_commands
   WHERE state IN ('delivered','failed','expired')
     AND updated_at < now() - interval '24 hours';

  -- Auto-release a stale admin binding so a crashed admin doesn't hold
  -- the peer hostage. Sessions with state=ended are handled by the
  -- clear_admin_binding_on_end trigger; here we only touch live rows.
  UPDATE public.sessions
     SET admin_client_id = NULL,
         admin_bound_at  = NULL
   WHERE state IN ('invited','consented','active','paused')
     AND admin_client_id IS NOT NULL
     AND (admin_bound_at IS NULL OR admin_bound_at < now() - interval '90 seconds');
END;
$function$;