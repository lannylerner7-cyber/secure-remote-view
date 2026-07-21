## Multi-admin role-based access control

Add support for multiple admin accounts with different permission levels, using the existing `user_roles` table and `has_role` function.

### Roles

Extend the `app_role` enum with three tiers:
- `super_admin` — full access: manage admins, settings (Telegram), delete sessions/audit, bulk actions, live control
- `admin` — standard operator: view devices, start sessions, live view + control, generate pairing codes
- `viewer` — read-only: dashboard, sessions list, audit log, live view **without** control (no pause/trackpad/keyboard)

### Database

- Migration: add `super_admin` and `viewer` to `app_role` enum (keep existing `admin`)
- Seed the existing `197200` account as `super_admin`
- Add `public.profiles` table (id → auth.users, display_name, created_at) with RLS + GRANTs, so super_admins can list/manage other admins by name
- RLS: super_admins can insert/update/delete rows in `user_roles`; everyone can select their own role

### Server functions (`src/lib/admins.functions.ts`)

- `listAdmins` (super_admin only) — returns profiles + roles
- `createAdmin` (super_admin only) — creates auth user via `supabaseAdmin`, inserts profile + role
- `updateAdminRole` (super_admin only) — change a user's role
- `deleteAdmin` (super_admin only) — remove auth user + profile + role
- `getMyRole` — returns current user's role (used by UI to gate features)

All privileged fns use `requireSupabaseAuth`, verify caller is `super_admin` via `context.supabase` under RLS, then load `supabaseAdmin` inside the handler.

### Admin UI (`src/routes/_authenticated/admin.tsx`)

- Fetch current role on mount; store in a context/hook `useRole()`
- Gate controls:
  - Sidebar "Settings" tab → super_admin only
  - "Pause user (take control)", trackpad, keyboard panel, shared note → hidden for `viewer`
  - Bulk actions, delete session, delete audit rows → super_admin only
  - Generate pairing code + Live view → admin + super_admin
- New sidebar entry **Team** (super_admin only): list admins, add new admin (email + password + role), change role, remove

### Out of scope

- Agent zip changes (no agent-side impact)
- Custom per-permission granularity beyond the 3 tiers above (can be added later if needed)

### Technical notes

```text
Role check path:
  UI  ──useRole()──▶ getMyRole() ──RLS──▶ user_roles (select own)
  Privileged action ──serverFn──▶ requireSupabaseAuth
                       ──▶ context.supabase.has_role(userId,'super_admin')
                       ──▶ supabaseAdmin.<action>
```
