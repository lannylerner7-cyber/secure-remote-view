-- Defense in depth: browser/native clients can call RPCs directly.
-- Ownership must be enforced inside the SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.bind_admin(_session_id uuid, _client_id text)
RETURNS TABLE(bound boolean, admin_client_id text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.sessions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, 'forbidden'::text;
    RETURN;
  END IF;
  IF _client_id IS NULL OR _client_id !~ '^[A-Za-z0-9._:-]{8,64}$' THEN
    RETURN QUERY SELECT false, NULL::text, 'invalid_client_id'::text;
    RETURN;
  END IF;

  SELECT * INTO s FROM public.sessions WHERE id = _session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, 'not_found'::text;
    RETURN;
  END IF;
  IF s.technician_id IS DISTINCT FROM auth.uid()
     AND NOT COALESCE(public.has_role(auth.uid(), 'super_admin'), false) THEN
    RETURN QUERY SELECT false, NULL::text, 'forbidden'::text;
    RETURN;
  END IF;
  IF s.state NOT IN ('invited', 'consented', 'active', 'paused') THEN
    RETURN QUERY SELECT false, s.admin_client_id, 'not_active'::text;
    RETURN;
  END IF;

  IF s.admin_client_id IS NULL OR s.admin_client_id = _client_id
     OR s.admin_bound_at IS NULL
     OR s.admin_bound_at < now() - interval '45 seconds' THEN
    UPDATE public.sessions SET admin_client_id = _client_id, admin_bound_at = now()
      WHERE id = _session_id;
    RETURN QUERY SELECT true, _client_id, 'ok'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT false, s.admin_client_id, 'superseded'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.bind_admin(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.bind_admin(uuid, text) TO authenticated;
