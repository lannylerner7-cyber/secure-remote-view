
DROP POLICY IF EXISTS "Staff can manage sessions" ON public.sessions;
DROP POLICY IF EXISTS "Viewers can read sessions" ON public.sessions;

CREATE POLICY "Super admins manage all sessions"
  ON public.sessions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Owners read own sessions"
  ON public.sessions FOR SELECT TO authenticated
  USING (technician_id = auth.uid());

CREATE POLICY "Staff create own sessions"
  ON public.sessions FOR INSERT TO authenticated
  WITH CHECK (
    technician_id = auth.uid() AND
    (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'technician'))
  );

CREATE POLICY "Owners update own sessions"
  ON public.sessions FOR UPDATE TO authenticated
  USING (technician_id = auth.uid())
  WITH CHECK (technician_id = auth.uid());

CREATE POLICY "Owners delete own sessions"
  ON public.sessions FOR DELETE TO authenticated
  USING (technician_id = auth.uid());

DROP POLICY IF EXISTS "Staff can read audit" ON public.audit_logs;
DROP POLICY IF EXISTS "Technicians can append audit" ON public.audit_logs;

CREATE POLICY "Super admins read all audit"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "Owners read scoped audit"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (
    actor = auth.uid() OR
    (session_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = audit_logs.session_id AND s.technician_id = auth.uid()
    ))
  );

CREATE POLICY "Staff append audit"
  ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'technician') OR public.has_role(auth.uid(), 'super_admin'));

CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Recipients read own or broadcast"
  ON public.notifications FOR SELECT TO authenticated
  USING (
    recipient_id IS NULL OR
    recipient_id = auth.uid() OR
    public.has_role(auth.uid(), 'super_admin')
  );

CREATE POLICY "Recipients mark own read"
  ON public.notifications FOR UPDATE TO authenticated
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

CREATE POLICY "Super admins manage notifications"
  ON public.notifications FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE INDEX notifications_recipient_created_idx
  ON public.notifications (recipient_id, created_at DESC);
CREATE INDEX notifications_broadcast_created_idx
  ON public.notifications (created_at DESC) WHERE recipient_id IS NULL;

ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

CREATE TABLE public.login_attempts (
  identifier TEXT PRIMARY KEY,
  failures INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_ip TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.login_attempts TO service_role;

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

CREATE INDEX login_attempts_locked_idx
  ON public.login_attempts (locked_until) WHERE locked_until IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prune_session_ephemera()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.session_inputs  WHERE created_at < now() - interval '10 minutes';
  DELETE FROM public.session_signals WHERE created_at < now() - interval '10 minutes';

  DELETE FROM public.session_frames f
    USING public.sessions s
   WHERE f.session_id = s.id
     AND s.state = 'ended'
     AND s.ended_at < now() - interval '5 minutes';

  DELETE FROM public.session_cursors c
    USING public.sessions s
   WHERE c.session_id = s.id
     AND s.state = 'ended'
     AND s.ended_at < now() - interval '5 minutes';

  DELETE FROM public.session_frames
   WHERE updated_at < now() - interval '1 hour'
     AND session_id NOT IN (SELECT id FROM public.sessions);
  DELETE FROM public.session_cursors
   WHERE updated_at < now() - interval '1 hour'
     AND session_id NOT IN (SELECT id FROM public.sessions);

  DELETE FROM public.audit_logs WHERE created_at < now() - interval '90 days';

  DELETE FROM public.login_attempts
   WHERE (locked_until IS NULL AND updated_at < now() - interval '1 day')
      OR (locked_until IS NOT NULL AND locked_until < now() - interval '1 day');

  DELETE FROM public.notifications
   WHERE created_at < now() - interval '30 days'
     AND (read_at IS NOT NULL OR recipient_id IS NULL);
END;
$function$;
