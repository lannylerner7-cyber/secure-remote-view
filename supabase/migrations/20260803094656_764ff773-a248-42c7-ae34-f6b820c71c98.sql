CREATE TABLE public.session_telemetry (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  admin_client_id TEXT,
  fps NUMERIC,
  latency_ms NUMERIC,
  queue_depth INTEGER,
  frames_decoded BIGINT,
  frames_dropped BIGINT,
  frames_presented BIGINT,
  source_width INTEGER,
  source_height INTEGER,
  render_path TEXT,
  input_path TEXT,
  wire_path TEXT,
  ice_restarts INTEGER,
  peer_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX session_telemetry_session_created_idx ON public.session_telemetry (session_id, created_at DESC);

GRANT SELECT, INSERT ON public.session_telemetry TO authenticated;
GRANT ALL ON public.session_telemetry TO service_role;

ALTER TABLE public.session_telemetry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read telemetry" ON public.session_telemetry FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'admin')
      OR public.has_role(auth.uid(),'technician') OR public.has_role(auth.uid(),'viewer'));

CREATE POLICY "Staff can write telemetry" ON public.session_telemetry FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'admin')
      OR public.has_role(auth.uid(),'technician'));