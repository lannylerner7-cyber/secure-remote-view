CREATE INDEX IF NOT EXISTS idx_session_frames_session ON public.session_frames (session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_session_cursors_session ON public.session_cursors (session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_session_inputs_created_at ON public.session_inputs (created_at);
CREATE INDEX IF NOT EXISTS idx_session_signals_created_at ON public.session_signals (created_at);
SELECT cron.alter_job(jobid, schedule := '*/5 * * * *') FROM cron.job WHERE jobname = 'connectlive-prune-ephemera';