
-- 1. Columns
ALTER TABLE public.sessions       ADD COLUMN IF NOT EXISTS admin_client_id text;
ALTER TABLE public.session_signals ADD COLUMN IF NOT EXISTS admin_client_id text;

-- 2. Broaden signal kind check to include "terminated" handshake
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.session_signals'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%kind%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.session_signals DROP CONSTRAINT %I', cname);
  END IF;
END$$;

ALTER TABLE public.session_signals
  ADD CONSTRAINT session_signals_kind_check
  CHECK (kind IN ('offer','answer','ice','bye','terminated'));

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_tech_state
  ON public.sessions (technician_id, state);
CREATE INDEX IF NOT EXISTS idx_session_signals_sess_admin_id
  ON public.session_signals (session_id, admin_client_id, id);

-- 4. Rewrite RLS: session-owner scope + super_admin
DROP POLICY IF EXISTS "Staff can view cursors"    ON public.session_cursors;
DROP POLICY IF EXISTS "Staff can view frames"     ON public.session_frames;
DROP POLICY IF EXISTS "Staff manage inputs"       ON public.session_inputs;
DROP POLICY IF EXISTS "Admins insert signals"     ON public.session_signals;
DROP POLICY IF EXISTS "Admins read all signals"   ON public.session_signals;

-- session_cursors: read for session owner or super_admin
CREATE POLICY "Session owners view cursors"
  ON public.session_cursors FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_cursors.session_id
        AND (s.technician_id = auth.uid() OR public.has_role(auth.uid(),'super_admin'))
    )
  );

-- session_frames: read for session owner or super_admin
CREATE POLICY "Session owners view frames"
  ON public.session_frames FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_frames.session_id
        AND (s.technician_id = auth.uid() OR public.has_role(auth.uid(),'super_admin'))
    )
  );

-- session_inputs: full manage for session owner or super_admin
CREATE POLICY "Session owners manage inputs"
  ON public.session_inputs FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_inputs.session_id
        AND (s.technician_id = auth.uid() OR public.has_role(auth.uid(),'super_admin'))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_inputs.session_id
        AND (s.technician_id = auth.uid() OR public.has_role(auth.uid(),'super_admin'))
    )
  );

-- session_signals: read + insert scoped to session owner or super_admin
CREATE POLICY "Session owners read signals"
  ON public.session_signals FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_signals.session_id
        AND (s.technician_id = auth.uid() OR public.has_role(auth.uid(),'super_admin'))
    )
  );

CREATE POLICY "Session owners insert signals"
  ON public.session_signals FOR INSERT
  TO authenticated
  WITH CHECK (
    from_side = 'admin' AND
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_signals.session_id
        AND (s.technician_id = auth.uid() OR public.has_role(auth.uid(),'super_admin'))
    )
  );
