REVOKE EXECUTE ON FUNCTION public.bind_admin(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bind_admin(uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.sync_device_session_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_device_session_active() TO service_role;