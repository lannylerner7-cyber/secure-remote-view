CREATE TABLE public.session_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('from_agent','from_admin')),
  name text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  mime text NOT NULL DEFAULT 'application/octet-stream',
  sha256 text,
  storage_path text NOT NULL,
  transport text NOT NULL DEFAULT 'datachannel' CHECK (transport IN ('datachannel','http')),
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX ix_session_files_session ON public.session_files (session_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.session_files TO authenticated;
GRANT ALL ON public.session_files TO service_role;

ALTER TABLE public.session_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Session files readable by owning technician or super admin"
ON public.session_files FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND s.technician_id = auth.uid())
);

CREATE POLICY "Session files writable by owning technician or super admin"
ON public.session_files FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND s.technician_id = auth.uid())
);

CREATE POLICY "Session files soft-deletable by owning technician or super admin"
ON public.session_files FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND s.technician_id = auth.uid())
)
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_id AND s.technician_id = auth.uid())
);

CREATE TABLE public.session_secrets (
  session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  wrapped_password text NOT NULL,
  iv text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours')
);

GRANT ALL ON public.session_secrets TO service_role;

ALTER TABLE public.session_secrets ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated: only server-side service role touches it.