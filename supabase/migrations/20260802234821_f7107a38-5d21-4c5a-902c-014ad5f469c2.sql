-- Both triggers execute public.sync_device_session_active() on public.sessions.
-- trg_sessions_sync_device_active is column-scoped (UPDATE OF state, device_id);
-- trg_sync_device_session_active fires on EVERY update (including updated_at
-- touches), so it is strictly the wasteful one. Keep the narrow trigger.
DROP TRIGGER IF EXISTS trg_sync_device_session_active ON public.sessions;