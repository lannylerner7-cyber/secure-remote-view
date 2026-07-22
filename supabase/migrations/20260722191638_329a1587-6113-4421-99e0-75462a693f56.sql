
REVOKE EXECUTE ON FUNCTION public.prune_session_ephemera() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.prune_session_ephemera() TO service_role;
