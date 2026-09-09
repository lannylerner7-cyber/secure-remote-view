# Detect "Agent killed" and "Agent never installed"

Two gaps in the admin console today:

1. When a user ends `ConnectLive.exe` from Task Manager, the process is force-killed — no goodbye packet is sent. The admin panel only notices ~60 s later, when the heartbeat gap sweep fires.
2. Machines that have never enrolled don't appear anywhere. The admin can't see "we expected this laptop to have the agent, but it doesn't".

This plan closes both, without adding a SYSTEM service (User-mode only is the chosen elevation model).

## What the admin will see

- A device that gets killed in Task Manager flips to a new `stopped` state within ~30 s, with a red badge "Agent stopped on device" and a Telegram alert "Agent process was terminated on {machine}".
- A new "Expected devices" tab lets an admin paste hostnames (or upload a CSV). Any hostname on that list without a matching enrolled device shows as "Agent not installed" with a copy-link button to the installer.
- The existing "device_offline" alert stays, but its wording changes to "unreachable" so it's distinct from "stopped".

## How we detect a Task Manager kill

The agent process itself can't report its own death — `TerminateProcess` skips every cleanup path. We need a second, tiny process to notice.

We already ship a **scheduled task** `ConnectLiveAgent` (ONLOGON, `/background`). Add a second scheduled task `ConnectLiveWatch` that runs every 1 minute under the same user:

- If `ConnectLive.exe` **is** running: no-op (exit 0).
- If `ConnectLive.exe` **is not** running and the machine has a stored device token:
  1. POST `/api/public/agent/beacon` with `{ reason: "stopped" }` using the DPAPI-stored token.
  2. Relaunch `ConnectLive.exe /background` (this is the self-heal we already do on logon, just moved to a 60 s tick).

The watch task is a ~5 KB console EXE (`ConnectLiveWatch.exe`) shipped alongside `ConnectLive.exe` and registered by `StartupSelfHeal.EnsureAll()`. It has no UI, no window, and exits immediately in the happy path.

Trade-off the user should know: because the watch task also relaunches the agent, a user who kills it in Task Manager will see it come back within 60 s. That's standard RMM behaviour and the price of "we notice it stopped". If the user wants a true "off" state, they uninstall — which is what the "Agent not installed" view is for.

## Server side

- New route `POST /api/public/agent/beacon` (device-token authed, same shape as `/heartbeat`) accepting `{ reason: "stopped" | "starting" | "uninstalling" }`. On `stopped`, sets `devices.status = 'stopped'`, `last_seen_at = now`, and inserts a notification row.
- Extend the `devices.status` check constraint to include `'stopped'`.
- Extend `notify.functions.ts` and `admin_settings` with `notify_on_agent_stopped` (defaults true).
- Console presence resolver: `stopped` wins over the age-based `online/reconnecting/offline` calculation, so a stopped machine reads "Stopped" until the next heartbeat flips it back to `online`.

## Expected-devices roster

- New table `expected_devices(id, owner_id, hostname, note, created_at)` with RLS scoping to `auth.uid()` and the standard grants.
- New serverfn `listExpectedWithStatus()` that left-joins against `devices.hostname` (case-insensitive) and returns `{ hostname, note, matched_device_id, status }` where status is `installed | not_installed`.
- New tab in the technician console: "Expected devices" — paste-in textarea (one hostname per line), CSV upload, and a table showing installed vs not-installed rows. Rows without a match get an "Install link" button that copies the download URL.

## Files touched

Server / web:
- `supabase/migrations/<ts>_agent_stopped_and_expected.sql` — extend `devices.status` enum-ish check, add `expected_devices`, add `notify_on_agent_stopped`.
- `src/routes/api/public/agent/beacon.ts` — new route.
- `src/shared/api-routes.ts` — register `agentBeacon`.
- `src/lib/notify.functions.ts` — add `agent_stopped` kind.
- `src/lib/expected-devices.functions.ts` — new serverfns (list/upsert/delete).
- `src/routes/_authenticated/console.tsx` — new "Expected devices" tab, `stopped` presence branch, updated Telegram wording.

Agent / packaging:
- `agent/src/Watch/Program.cs` — new tiny console app project `ConnectLiveWatch.csproj`.
- `agent/src/StartupSelfHeal.cs` — also register the `ConnectLiveWatch` scheduled task (1-minute tick).
- `agent/packaging/inno/ConnectLiveSetup.iss` — ship `ConnectLiveWatch.exe` next to `ConnectLive.exe`.
- `agent/packaging/msi/ConnectLive.wxs` — same.
- `agent/src/ApiClient.cs` — add `PostBeaconAsync(reason)` for the watch app to reuse via a shared assembly, or duplicate the ~30 LOC device-token POST inside the watch app to keep it dependency-free (leaning: duplicate; the watch app should be tiny and standalone).

Docs:
- `PROJECT-MAP.md` — new §10.37 "Agent stopped detection + expected-devices roster".
- `ENDPOINTS.md` — add `/api/public/agent/beacon`.

## Out of scope

- Auto-discovering LAN hosts without an agent (would need a network scan from an enrolled device — separate scope).
- SYSTEM-service elevation to make the agent unkillable — user chose User-mode only.
- Removing the auto-relaunch (see trade-off above).

## Technical details

- `devices.status` today is a free `text` column populated with `'online'` and `'offline'`. Add a CHECK constraint `status IN ('online','offline','stopped')` in the same migration; existing rows are already one of the first two.
- The beacon route reuses `verifyDevice(request)` from `src/lib/agent-auth.server.ts`; no new auth surface.
- The watch app targets `net8.0-windows` with `PublishSingleFile=true`, `SelfContained=false` (matches the agent's runtime posture), so it inherits the same signed `.NET 8 Desktop Runtime` requirement already documented.
- `expected_devices` matching is case-insensitive on `lower(hostname)`; both sides trim trailing dots and domain suffixes so `PC-42` matches `pc-42.corp.local`.
