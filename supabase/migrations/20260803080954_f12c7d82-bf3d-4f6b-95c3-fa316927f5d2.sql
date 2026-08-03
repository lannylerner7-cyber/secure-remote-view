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

  -- ---------------------------------------------------------------
  -- Presence reaper
  -- ---------------------------------------------------------------
  -- 1. A device is "online" only while it is heartbeating. The idle
  --    cadence is 60s while the SSE stream is healthy, 10s otherwise,
  --    so 3 minutes is three missed beats at the slowest cadence.
  UPDATE public.devices
     SET status = 'offline'
   WHERE status <> 'offline'
     AND (last_seen_at IS NULL OR last_seen_at < now() - interval '3 minutes');

  -- 2. A live session whose device stopped heartbeating is dead. End it
  --    so the console, the is_session_active trigger and the reuse path
  --    all agree. 10 minutes is deliberately far past the offline mark:
  --    a brief network flip must be able to reconnect into the session.
  WITH reaped AS (
    UPDATE public.sessions s
       SET state    = 'ended',
           ended_at = now()
      FROM public.devices d
     WHERE s.device_id = d.id
       AND s.state IN ('invited','consented','active','paused')
       AND (d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '10 minutes')
    RETURNING s.id, s.device_id
  )
  INSERT INTO public.audit_logs (session_id, device_id, event, detail)
  SELECT id, device_id, 'session.reaped',
         jsonb_build_object('reason','device_silent','by','prune_session_ephemera')
    FROM reaped;

  -- 3. Ghost enrollments: a token was issued but the agent never came
  --    back. No name, no second heartbeat, never in a session, 24h old.
  DELETE FROM public.devices d
   WHERE d.enrolled_at < now() - interval '24 hours'
     AND (d.last_seen_at IS NULL OR d.last_seen_at <= d.enrolled_at + interval '2 minutes')
     AND (d.display_name IS NULL OR d.display_name IN ('', 'Unnamed device'))
     AND NOT EXISTS (SELECT 1 FROM public.sessions       s WHERE s.device_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.power_commands p WHERE p.device_id = d.id OR p.relay_device_id = d.id);
END;
$function$;