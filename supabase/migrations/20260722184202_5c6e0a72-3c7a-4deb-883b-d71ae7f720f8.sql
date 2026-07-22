CREATE TABLE public.session_cursors (
  session_id UUID PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  x INT NOT NULL,
  y INT NOT NULL,
  frame_w INT,
  frame_h INT,
  kind TEXT NOT NULL DEFAULT 'default',
  visible BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.session_cursors TO authenticated;
GRANT ALL ON public.session_cursors TO service_role;

ALTER TABLE public.session_cursors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view cursors" ON public.session_cursors FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'technician'));

ALTER PUBLICATION supabase_realtime ADD TABLE public.session_cursors;
ALTER TABLE public.session_cursors REPLICA IDENTITY FULL;