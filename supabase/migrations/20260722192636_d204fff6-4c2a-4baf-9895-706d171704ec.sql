
REVOKE ALL ON FUNCTION public.prune_session_ephemera() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_session_ephemera() TO service_role;
