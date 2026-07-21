CREATE TABLE public.session_signals (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  from_side TEXT NOT NULL CHECK (from_side IN ('admin','agent')),
  kind TEXT NOT NULL CHECK (kind IN ('offer','answer','ice','bye')),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX session_signals_session_id_idx ON public.session_signals(session_id, id);

GRANT SELECT, INSERT ON public.session_signals TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.session_signals_id_seq TO authenticated;
GRANT ALL ON public.session_signals TO service_role;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.session_signals_id_seq TO service_role;

ALTER TABLE public.session_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read all signals"
  ON public.session_signals FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'viewer')
  );

CREATE POLICY "Admins insert signals"
  ON public.session_signals FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'admin')
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.session_signals;