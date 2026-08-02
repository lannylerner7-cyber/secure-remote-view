ALTER TABLE public.session_frames REPLICA IDENTITY DEFAULT;

CREATE INDEX IF NOT EXISTS idx_power_commands_device_queue_expiry
ON public.power_commands (device_id, state, expires_at)
WHERE state IN ('queued', 'dispatched');