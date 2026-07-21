
CREATE TABLE public.session_frames (
  session_id UUID PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  frame TEXT NOT NULL,
  width INT,
  height INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.session_frames TO authenticated;
GRANT ALL ON public.session_frames TO service_role;

ALTER TABLE public.session_frames ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Technicians can view frames"
  ON public.session_frames FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'technician'));

ALTER PUBLICATION supabase_realtime ADD TABLE public.session_frames;
ALTER TABLE public.session_frames REPLICA IDENTITY FULL;
