ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_state_check
  CHECK (state IN ('invited', 'consented', 'active', 'paused', 'declined', 'ended'));

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_mode_check
  CHECK (mode IN ('view', 'control'));