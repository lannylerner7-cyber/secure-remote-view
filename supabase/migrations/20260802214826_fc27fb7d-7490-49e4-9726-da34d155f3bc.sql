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

DROP TRIGGER IF EXISTS trg_sync_device_session_active ON public.sessions;
CREATE TRIGGER trg_sync_device_session_active
AFTER INSERT OR UPDATE OR DELETE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.sync_device_session_active();

DROP TRIGGER IF EXISTS trg_clear_admin_binding_on_end ON public.sessions;
CREATE TRIGGER trg_clear_admin_binding_on_end
BEFORE UPDATE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.clear_admin_binding_on_end();