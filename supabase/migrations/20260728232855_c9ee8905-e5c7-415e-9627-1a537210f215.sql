ALTER FUNCTION public.clear_admin_binding_on_end() SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION public.clear_admin_binding_on_end() FROM PUBLIC;