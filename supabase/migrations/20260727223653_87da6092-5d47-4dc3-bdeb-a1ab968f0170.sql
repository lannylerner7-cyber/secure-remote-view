-- 1) CREATE TABLE
CREATE TABLE public.power_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  relay_device_id uuid REFERENCES public.devices(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('wake','reboot','shutdown','lock','logoff')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','dispatched','delivered','failed','expired')),
  requested_by uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  delivered_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX power_commands_relay_state_idx ON public.power_commands (relay_device_id, state);
CREATE INDEX power_commands_device_state_idx ON public.power_commands (device_id, state);

-- 2) GRANTs
GRANT SELECT, INSERT, UPDATE, DELETE ON public.power_commands TO authenticated;
GRANT ALL ON public.power_commands TO service_role;

-- 3) RLS
ALTER TABLE public.power_commands ENABLE ROW LEVEL SECURITY;

-- 4) POLICIES
-- Staff (super_admin/admin/technician) can read all power commands
CREATE POLICY "Staff read power commands"
  ON public.power_commands FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'technician'::app_role)
    OR has_role(auth.uid(), 'viewer'::app_role)
  );

-- Only super_admin/admin/technician can insert; requested_by must match caller
CREATE POLICY "Staff queue power commands"
  ON public.power_commands FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND (
      has_role(auth.uid(), 'super_admin'::app_role)
      OR has_role(auth.uid(), 'admin'::app_role)
      OR has_role(auth.uid(), 'technician'::app_role)
    )
  );

-- Super admins can update/delete for maintenance
CREATE POLICY "Super admin manage power commands"
  ON public.power_commands FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'super_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'super_admin'::app_role));

-- updated_at trigger
CREATE TRIGGER power_commands_touch_updated_at
  BEFORE UPDATE ON public.power_commands
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Extend the existing pruning function to sweep old power_commands
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

  -- New: expire stale queued commands and prune finished ones
  UPDATE public.power_commands
     SET state = 'expired'
   WHERE state IN ('queued','dispatched')
     AND expires_at < now();

  DELETE FROM public.power_commands
   WHERE state IN ('delivered','failed','expired')
     AND updated_at < now() - interval '24 hours';
END;
$function$;
