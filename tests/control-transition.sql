-- Run ONLY in an empty disposable PostgreSQL database, never production.
\set ON_ERROR_STOP on
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TYPE public.app_role AS ENUM ('super_admin','admin','user','technician');
CREATE TABLE public.user_roles(user_id uuid, role public.app_role);
CREATE TABLE public.licenses(id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.devices(id uuid PRIMARY KEY, license_id uuid, is_session_active boolean);
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$
 SELECT current_setting('test.role', true)
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
 SELECT current_setting('test.uid', true)::uuid
$$;
CREATE TABLE public.device_authorizations (
 id uuid PRIMARY KEY, device_id uuid, capabilities jsonb, revoked_at timestamptz,
 owner_id uuid, notice_version integer, mode text
);
CREATE TABLE public.sessions (
 id uuid PRIMARY KEY, device_id uuid, technician_id uuid, consent_at timestamptz,
 state text, mode text, authorization_id uuid, authorization_mode text,
 admin_client_id text, updated_at timestamptz
);
-- Seed an already-authorized session before installing the actual triggers.
INSERT INTO licenses VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000004');
INSERT INTO devices VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000005',true);
INSERT INTO device_authorizations VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
 '{"view":true,"control":true,"clipboard":false,"files":false,"recording":false}',null,
 '00000000-0000-0000-0000-000000000004',1,'unattended');
INSERT INTO sessions VALUES
 ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004',now(),'active','view','00000000-0000-0000-0000-000000000001','unattended',null,now());
\i :production_functions
\ir ../supabase/migrations/20261022001000_allow_recorded_control_transition.sql
\ir ../supabase/migrations/20261022002000_reconcile_recorded_control_guard.sql
GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT SELECT,INSERT,UPDATE ON sessions TO authenticated;
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
 UPDATE sessions SET mode='control';
 IF FOUND THEN RAISE EXCEPTION 'Wrong technician accepted'; END IF;
END $$;
SET test.uid='00000000-0000-0000-0000-000000000004';
RESET ROLE;
UPDATE device_authorizations SET capabilities=jsonb_set(capabilities,'{control}','false');
SET ROLE authenticated;
DO $$ BEGIN
 BEGIN UPDATE sessions SET mode='control'; RAISE EXCEPTION 'View-only control accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
UPDATE device_authorizations SET capabilities=jsonb_set(capabilities,'{control}','true'),revoked_at=now();
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
