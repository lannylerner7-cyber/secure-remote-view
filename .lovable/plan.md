## What we're building

Four capabilities, one pass, no removed features.

### 1. Team page in the admin menu (super_admin only)

Add a "Team" entry to the sidebar in `admin.tsx`. The page reuses the existing `listAdmins` / `createAdmin` / `updateAdminRole` / `deleteAdmin` server fns in `src/lib/admins.functions.ts` — no new backend needed.

The page shows:

- A paginated, searchable table of every admin (id, email, display name, role, created_at). Server-side search + `range()` pagination so 20k+ rows never load at once.
- "Add admin" modal — email, display name, password, role picker.
- Per-row role edit + delete (delete disabled on self and on 197200).
- Bulk-delete for multi-select.

Only `super_admin` sees the menu item and can hit the page (client + `assertSuperAdmin` on every fn — already in place).

### 2. Per-admin data isolation

Today every admin/technician sees the full fleet's sessions and audit logs. New rule: **each admin only sees the sessions they created and the audit rows for those sessions; super_admin sees everything.**

Verified current RLS:

- `sessions`: "Staff can manage sessions" — any staff sees any row.
- `audit_logs`: "Staff can read audit" — any staff sees any row.
- `devices`: fleet-wide (kept as-is — devices are shared inventory, not per-admin).

Migration:

- Replace the two blanket policies with role-scoped ones:
  - `sessions` SELECT/UPDATE/DELETE: `super_admin` OR `technician_id = auth.uid()`. INSERT keeps requiring staff role AND forces `technician_id = auth.uid()` via `WITH CHECK`.
  - `audit_logs` SELECT: `super_admin` OR `session_id IN (SELECT id FROM sessions WHERE technician_id = auth.uid())`. Uses the existing `sessions_technician_created_idx`.
- Frontend `refresh()` in `admin.tsx` already relies on RLS to filter — no code change needed once policies tighten.

### 3. Super-admin push notifications (in-app bell)

send notification to all admin New `notifications` table (`id`, `recipient_id` nullable = broadcast, `sender_id`, `title`, `body`, `severity`, `created_at`, `read_at`). RLS: recipient sees own rows + broadcast rows; super_admin sees/writes all; nobody else writes.

New server fns in `src/lib/notifications.functions.ts`:

- `broadcastNotification({ title, body, severity })` — super_admin only, inserts one broadcast row (recipient_id NULL).
- `sendNotification({ recipient_id, ... })` — super_admin only, direct.
- `markRead({ id })` — recipient marks own.

Header bell component (all admins):

- Subscribes to `notifications` via Supabase Realtime, filtered by `recipient_id=eq.<me>` OR `recipient_id=is.null`.
- Unread count badge; dropdown shows last 20.
- Browser Notification API prompt so it also appears in the OS notification bar when the tab is unfocused.

Super-admin Team page gets a "Broadcast" panel: title + body + severity + Send.

### 4. Login rate limit — 3 failed attempts → 1-hour lockout

`supabase.auth.signInWithPassword` runs in the browser and can't enforce this alone. Move sign-in through a server fn.

New `login_attempts` table (`identifier` TEXT PK part, `ip` TEXT, `failures` INT, `locked_until` TIMESTAMPTZ, `updated_at`). Server-only — no anon/authenticated grants.

New public server route `src/routes/api/public/auth/login.ts` (server route, not server fn, because it needs raw `Response` + IP header access):

1. Read `identifier` (technician ID or email) + password + client IP.
2. Look up `login_attempts` row keyed on lowercased identifier.
3. If `locked_until > now()` → return 423 with seconds remaining. No password check runs.
4. Otherwise call `supabaseAdmin.auth.signInWithPassword`.
5. Success → reset the row, return session JSON; client calls `supabase.auth.setSession()` to hydrate.
6. Failure → increment failures; if failures ≥ 3 set `locked_until = now() + 1 hour` and reset counter; return 401 with `attemptsLeft` or `lockedFor`.

Cleanup: extend the `prune_session_ephemera` cron (already scheduled every minute) to also delete `login_attempts` rows where `locked_until < now() - 1 day`.

`login.tsx` updates:

- Submit posts to the new route instead of `supabase.auth.signInWithPassword` directly.
- Show "Account locked for X minutes" or "N attempts left" from the response.
- Keep the existing tech-id-to-email mapping.

## Scale notes

- 20k+ admins is well within Postgres + the indexes we already have (`profiles_email_lower_idx`, `sessions_technician_created_idx`). Team list uses server-side pagination and trigram search on `profiles.email` / `display_name`.
- Broadcast notifications write **one** row, not one-per-admin — the query joins `recipient_id IS NULL` at read time. O(1) writes regardless of admin count.
- The scoped `audit_logs` policy uses an EXISTS subquery hitting the already-indexed `sessions_technician_created_idx`, so drilldowns stay fast.

## Technical details

- Two migrations: policy swap on `sessions`/`audit_logs`, then the two new tables (`notifications`, `login_attempts`) with GRANTs + RLS + indexes.
- All new server fns follow the existing `assertSuperAdmin` + `requireSupabaseAuth` pattern.
- The login route is `/api/public/auth/*` so it bypasses the auth gate (unauthenticated by definition). Rate-limit logic runs inside the handler.
- `notifications` gets an index on `(recipient_id, created_at DESC)` and a partial index on `(created_at DESC) WHERE recipient_id IS NULL` for the broadcast feed.

## Out of scope

- Real mobile push (APNs/FCM). "Notification bar" here means the browser's Notification API + in-app bell — no third-party push provider.
- Changing device visibility (still fleet-shared inventory).
- Touching the agent binary — this is admin-panel-only work.

## Confirm before I build

- Per-admin scoping means admin A **cannot** see or resume a session admin B started. Fine, or do you want admins to still see all sessions and only the audit trail scoped?