-- Close existing realtime/privilege gaps without changing application data.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- These tables have no client policies or supported direct browser access.
-- RLS does not protect TRUNCATE: remove historical table-level client grants.
REVOKE ALL ON public.cron_tokens, public.session_secrets, public.smtp_settings,
  public.login_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cron_tokens, public.session_secrets, public.smtp_settings,
  public.login_attempts TO service_role;

-- Audit read policies still determine which authenticated subscribers see rows.
DO $$
DECLARE item text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND NOT puballtables) THEN
    FOREACH item IN ARRAY ARRAY['audit_logs','agent_runtime'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = item) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', item);
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
