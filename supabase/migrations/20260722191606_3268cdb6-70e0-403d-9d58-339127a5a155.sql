
-- Enable trigram FIRST so gin_trgm_ops is resolvable in the same tx
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Devices: fleet listings sort by last_seen, filter by status
CREATE INDEX IF NOT EXISTS devices_last_seen_idx        ON public.devices (last_seen_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS devices_status_last_seen_idx ON public.devices (status, last_seen_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS devices_hostname_trgm_idx    ON public.devices USING gin (hostname public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS devices_display_name_trgm_idx ON public.devices USING gin (display_name public.gin_trgm_ops);

-- Sessions
CREATE INDEX IF NOT EXISTS sessions_state_created_idx      ON public.sessions (state, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_technician_created_idx ON public.sessions (technician_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_device_created_idx     ON public.sessions (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_active_partial_idx     ON public.sessions (updated_at DESC)
  WHERE state IN ('invited','active','paused');

-- Audit logs
CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx   ON public.audit_logs (actor,      created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_device_created_idx  ON public.audit_logs (device_id,  created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_session_created_idx ON public.audit_logs (session_id, created_at DESC);

-- Realtime tables
CREATE INDEX IF NOT EXISTS session_frames_updated_idx  ON public.session_frames  (updated_at);
CREATE INDEX IF NOT EXISTS session_cursors_updated_idx ON public.session_cursors (updated_at);
CREATE INDEX IF NOT EXISTS session_inputs_created_idx  ON public.session_inputs  (created_at);
CREATE INDEX IF NOT EXISTS session_signals_created_idx ON public.session_signals (created_at);

-- Profiles
CREATE INDEX IF NOT EXISTS profiles_email_lower_idx ON public.profiles (lower(email));

-- Retention pruner
CREATE OR REPLACE FUNCTION public.prune_session_ephemera()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
END;
$$;

REVOKE ALL ON FUNCTION public.prune_session_ephemera() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_session_ephemera() TO service_role;

-- Schedule via pg_cron if available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'connectlive-prune-ephemera') THEN
      PERFORM cron.unschedule('connectlive-prune-ephemera');
    END IF;
    PERFORM cron.schedule(
      'connectlive-prune-ephemera',
      '*/1 * * * *',
      $cron$ SELECT public.prune_session_ephemera(); $cron$
    );
  END IF;
END $$;

-- Autovacuum tuning for high-churn tables
ALTER TABLE public.devices         SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.sessions        SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.session_inputs  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.session_signals SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.audit_logs      SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);

ANALYZE public.devices;
ANALYZE public.sessions;
ANALYZE public.audit_logs;
