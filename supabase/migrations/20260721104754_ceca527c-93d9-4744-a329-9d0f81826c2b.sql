ALTER TABLE public.sessions ALTER COLUMN device_id DROP NOT NULL;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS pairing_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_pairing_code_active_uq ON public.sessions (pairing_code) WHERE pairing_code IS NOT NULL AND state IN ('invited','active','paused');