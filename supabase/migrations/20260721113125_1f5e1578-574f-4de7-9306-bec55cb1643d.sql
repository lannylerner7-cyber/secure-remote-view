
CREATE TABLE public.session_inputs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_inputs_session_seq_idx ON public.session_inputs(session_id, id);

GRANT SELECT, INSERT, DELETE ON public.session_inputs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.session_inputs_id_seq TO authenticated;
GRANT ALL ON public.session_inputs TO service_role;
GRANT ALL ON SEQUENCE public.session_inputs_id_seq TO service_role;

ALTER TABLE public.session_inputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "technicians manage inputs"
  ON public.session_inputs FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'technician'::app_role) OR public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'technician'::app_role) OR public.has_role(auth.uid(), 'admin'::app_role));
