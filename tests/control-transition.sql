-- Run ONLY in an empty disposable PostgreSQL database, never production.
\set ON_ERROR_STOP on
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$
 SELECT current_setting('test.role', true)
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
 SELECT current_setting('test.uid', true)::uuid
$$;
CREATE TABLE public.device_authorizations (
 id uuid PRIMARY KEY, device_id uuid, capabilities jsonb, revoked_at timestamptz
);
CREATE TABLE public.sessions (
 id uuid PRIMARY KEY, device_id uuid, technician_id uuid, consent_at timestamptz,
 state text, mode text, authorization_id uuid
);
-- Isolate the new transition logic from the separately maintained full
-- session_authorized predicate. This fixture checks its view-only precondition.
CREATE FUNCTION public.session_authorized(sid uuid, capability text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM public.sessions s
 JOIN public.device_authorizations a ON a.id=s.authorization_id AND a.device_id=s.device_id
 WHERE s.id=sid AND s.state='active' AND s.consent_at IS NOT NULL
 AND a.revoked_at IS NULL AND a.capabilities->'view'='true'::jsonb
 AND s.technician_id=auth.uid() AND capability='view')
$$;
\ir ../supabase/migrations/20261022001000_allow_recorded_control_transition.sql
CREATE TRIGGER guard_client_session_transitions BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION guard_client_session_transitions();
GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT SELECT,INSERT,UPDATE ON sessions TO authenticated;
INSERT INTO device_authorizations VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','{"view":true,"control":true}',null);
INSERT INTO sessions VALUES
 ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004',now(),'active','view','00000000-0000-0000-0000-000000000001');
SET test.role='authenticated';
SET test.uid='00000000-0000-0000-0000-000000000004';
SET ROLE authenticated;
UPDATE sessions SET mode='control';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sessions WHERE mode='control') THEN RAISE EXCEPTION 'Authorized control failed'; END IF;
 BEGIN UPDATE sessions SET technician_id='00000000-0000-0000-0000-000000000005';
 RAISE EXCEPTION 'Identity change accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
UPDATE sessions SET mode='view';
SET test.uid='00000000-0000-0000-0000-000000000005';
DO $$ BEGIN
 BEGIN UPDATE sessions SET mode='control'; RAISE EXCEPTION 'Wrong technician accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET test.uid='00000000-0000-0000-0000-000000000004';
RESET ROLE;
UPDATE device_authorizations SET capabilities='{"view":true,"control":false}';
SET ROLE authenticated;
DO $$ BEGIN
 BEGIN UPDATE sessions SET mode='control'; RAISE EXCEPTION 'View-only control accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
UPDATE device_authorizations SET capabilities='{"view":true,"control":true}',revoked_at=now();
SET ROLE authenticated;
DO $$ BEGIN
 BEGIN UPDATE sessions SET mode='control'; RAISE EXCEPTION 'Revoked control accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
UPDATE sessions SET state='paused';
DO $$ BEGIN
 BEGIN UPDATE sessions SET state='active'; RAISE EXCEPTION 'Paused reactivation accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
UPDATE sessions SET state='ended';
DO $$ BEGIN
 BEGIN UPDATE sessions SET state='active'; RAISE EXCEPTION 'Closed reactivation accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT 'PASS: authorized control, identity, ownership, view-only, revocation and terminal transitions' AS result;
