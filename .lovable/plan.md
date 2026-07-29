
## Goal

Kill the "Contact your administrator to install the ConnectLive package with a valid deployment key" popup by removing the deployment-key gate end-to-end, AND make sure the Admin console immediately sees devices as they auto-enroll and keeps its own session live across network blips.

The Agent (and Watcher) will silently POST `/api/public/agent/enroll` on first boot, the server mints a per-device token, and the token is DPAPI-encrypted into `%ProgramData%\ConnectLive\device.dat`. The Admin console gains a resilient device-list refresh + auth-session refresh loop so newly-enrolled machines appear without a manual reload and admin stays signed in through transient failures.

## Current state (verified)

- `src/routes/api/public/agent/enroll.ts` rejects any request whose `X-Deployment-Key` header doesn't match `AGENT_DEPLOYMENT_KEY`. Source of the popup.
- `agent/src/ApiClient.cs::EnrollIfNeededAsync` throws `"No deployment key found..."` when nothing is configured — the exact popup text via `App.xaml.cs`.
- `agent/watcher/Program.cs::TryEnrollAsync` silently no-ops without a key, so Watcher never enrolls either.
- `agent/src/DeploymentKey.cs` + `agent/packaging/inno/ConnectLiveSetup.iss` exist only to feed the key file.
- `admin/src/Api/ApiClient.cs` + `admin/src/ViewModels/DevicesViewModel.cs` fetch devices once on login; there is no continuous refresh loop, and no auto-recovery when the Supabase session token expires or a request 401s. That's why fresh enrollments only show after a manual reconnect today.
- `public.devices` already carries the enroll output (`metadata.token_hash` verified by `src/lib/agent-auth.server.ts`); no schema change required.

## Changes

### 1. Server — `src/routes/api/public/agent/enroll.ts`
- Remove `AGENT_DEPLOYMENT_KEY` check and `X-Deployment-Key` header. Always accept, insert the device row, return `{ deviceId, deviceToken }`.
- Add lightweight per-IP throttle (reuse the `login_attempts` pattern) so open enroll isn't abusable: N enrolls/min per masked IP → 429 with short cool-down. Audit-log `device.auto_enrolled` unchanged.
- `AGENT_DEPLOYMENT_KEY` env becomes unused; leave the secret in place, no migration.

### 2. Agent — `agent/src/ApiClient.cs`
- `EnrollIfNeededAsync`: drop the `DeploymentKey.Resolve()` lookup and the throw. Always POST enroll with the current payload. No `X-Deployment-Key` header.
- Keep DPAPI `device.dat` persistence and the 401 → wipe → re-enroll → retry logic in `SendAuthedAsync`.

### 3. Watcher — `agent/watcher/Program.cs`
- `TryEnrollAsync`: remove the `ResolveDeploymentKey()` gate. Always enroll when `device.dat` is missing.
- Delete `DeploymentKeyFile`, `EmbeddedDeploymentKey`, `ResolveDeploymentKey()`.

### 4. `agent/src/DeploymentKey.cs`
- Delete the file. Nothing references it after 2 + 3.

### 5. Inno installer — `agent/packaging/inno/ConnectLiveSetup.iss` + README
- Remove `/KEY=` parsing, sidecar `deployment.key` copy, `SaveStringToFile` block, and UI text mentioning the key. Keep service install, ACLs, uninstall reorder.
- Update `agent/packaging/inno/README.md` and `agent/INSTALL.md` to describe "install → first heartbeat auto-registers".

### 6. Admin console — persistent connection to the new enrollment mesh

Because devices now appear on their own, the console must poll and self-heal instead of relying on the login-time fetch.

**`admin/src/Api/ApiClient.cs`**
- Add a shared `SendWithAuthRetryAsync` wrapper mirroring the Agent's single-flight 401 recovery: on 401, call `AuthStore.RefreshSessionAsync()` (Supabase refresh_token) once, retry the request. If refresh fails, surface a single "session expired" toast and reopen the login window — never crash the process.
- Reuse this wrapper for `ListDevicesAsync`, `PollSessionCursorAsync`, `EnqueuePowerCommandAsync`, signal poll/post, and frame poll — everything the console currently sends with a bearer.
- Add transient-failure retry (3× exponential back-off, jitter) around network exceptions so a brief LAN drop doesn't drop the list.

**`admin/src/Api/AuthStore.cs`**
- Persist `refresh_token` alongside `access_token` in the existing DPAPI blob.
- Add `RefreshSessionAsync()` that calls Supabase `/auth/v1/token?grant_type=refresh_token`, rewrites the blob, and fires an `OnSessionRefreshed` event. All ApiClient calls read the current token via a getter so a refresh mid-flight is picked up on retry.
- Add a background refresh timer (fires at `expires_at - 60s`) so we refresh proactively instead of only reacting to 401s.

**`admin/src/ViewModels/DevicesViewModel.cs`**
- Replace the one-shot fetch with a `DispatcherTimer` (10 s cadence) that calls `ListDevicesAsync` and merges results in place: preserve selection, only mutate rows whose `updated_at`/`is_session_active`/`status` changed. New rows fade in; missing rows drop out. This is what makes freshly-enrolled devices appear without a reload.
- Pause the timer while a `LiveSessionWindow` is open to avoid competing with the live-view pumps; resume on close.
- Show a small status pip in the header: green (last poll < 15 s ago), amber (retrying), red (auth lost).

**`admin/src/App.xaml.cs`**
- On startup, if `AuthStore` has a saved refresh token, attempt a silent refresh before opening the main window; on success skip the login screen. On failure, open login normally. This is the "connection stays persistent" bit across app restarts.

### 7. Docs
- Update `agent/README.md`, `agent/INSTALL.md`, `admin/INSTALL.md`, GPO/Intune/Jamf READMEs to drop deployment-key steps and describe the new auto-register + persistent-admin flow.

## Not doing

- No client-side GUID minting on the Agent. The server already returns a random token and stores only its SHA-256 hash — stronger than a client-picked GUID and keeps `src/lib/agent-auth.server.ts` verification unchanged.
- No schema changes. No `agent_token` column; token lives hashed in `metadata.token_hash`.
- No changes to WebRTC signaling, `bind_admin`, or session lifecycle.

## Verification

- `rg -n "Deployment-?Key|deployment\.key|AGENT_DEPLOYMENT_KEY"` returns nothing outside audit-log strings.
- `bunx tsgo` clean; `scripts/verify-agent-routes.ts` passes.
- Manual: fresh Windows box with no `deployment.key` — launch `ConnectLiveAgent.exe`, `device.dat` is written, heartbeat 200, no popup. Admin console (already open on another box) shows the new device within ~10 s without a manual refresh. Kill the admin's network for 30 s: status pip goes amber, then green again once traffic resumes; no re-login required.

## Deliverable

After approval I'll apply the edits and repackage **both** source zips (Agent+Watcher+Inno, and Admin console) since both sides changed.
