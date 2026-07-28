-- Index for the poll filter used by both admin and agent
CREATE INDEX IF NOT EXISTS idx_session_signals_routing
  ON public.session_signals (session_id, admin_client_id, id);

-- Replace the admin INSERT policy with strict admin_client_id enforcement
DROP POLICY IF EXISTS "Session owners insert signals" ON public.session_signals;

CREATE POLICY "Session owners insert signals"
ON public.session_signals
FOR INSERT
TO authenticated
WITH CHECK (
  from_side = 'admin'
  AND admin_client_id IS NOT NULL
  AND char_length(admin_client_id) BETWEEN 8 AND 64
  AND EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = session_signals.session_id
      AND (
        s.technician_id = auth.uid()
        OR public.has_role(auth.uid(), 'super_admin'::app_role)
      )
      AND (
        s.admin_client_id IS NULL
        OR s.admin_client_id = session_signals.admin_client_id
      )
  )
);

-- Trigger: on session state -> ended, clear the admin binding
CREATE OR REPLACE FUNCTION public.clear_admin_binding_on_end()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.state = 'ended' AND (OLD.state IS DISTINCT FROM 'ended') THEN
    NEW.admin_client_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_admin_binding_on_end ON public.sessions;
CREATE TRIGGER trg_clear_admin_binding_on_end
BEFORE UPDATE ON public.sessions
FOR EACH ROW
EXECUTE FUNCTION public.clear_admin_binding_on_end();