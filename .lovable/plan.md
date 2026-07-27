# Auto-Enrollment ("Double Vouch" Phase 2)

Replace the manual 6-digit pairing code with a silent Deployment-Key handshake so the Watcher enrolls itself on first boot and every subsequent connection is admin-initiated only. Keeps the Curtain Mode / Live Session banners intact.

## Flow

```text
First boot (no device.dat)
  Watcher ──POST /api/public/agent/enroll──▶ Backend
           X-Deployment-Key: <secret>
           body: { hostname, os, mac, displayName }
                                      │
                    verify key, insert devices row
                                      │
           ◀── { deviceId, deviceToken } ──
  Watcher DPAPI-encrypts to %ProgramData%\ConnectLive\device.dat

Every boot after
  Watcher ──POST /heartbeat with X-Device-Id + X-Device-Token──▶ Backend
  Admin clicks "Connect" in panel → session row created → Watcher spawns Agent
  (no user prompt, no PIN)
```

## Backend changes

1. **New secret `AGENT_DEPLOYMENT_KEY`** (generated via `generate_secret`, 64 chars). Server-only.
2. **`src/routes/api/public/agent/enroll.ts`** — gate on `X-Deployment-Key` header, timing-safe compare against `process.env.AGENT_DEPLOYMENT_KEY`. Reject with 401 if missing/mismatch. Keep the existing device row + token generation, add `mac` + `enrolled_via: "deployment_key"` into `metadata`. Rate-limit per IP (reuse `login_attempts` table pattern) to blunt key-guessing.
3. **Deprecate `/api/public/agent/pair`** — mark handler to return 410 Gone. Remove `pairing_code` UI paths from admin. (Keep the DB column; harmless.)
4. **Audit log** — `device.auto_enrolled` event with hostname + truncated IP.

## Watcher changes (`agent/watcher/Program.cs`)

1. On tick, if `device.dat` is missing AND `AGENT_DEPLOYMENT_KEY` is embedded, call `/enroll` with hostname/os/mac before heartbeating. Persist result via DPAPI `LocalMachine` scope (matches current reader).
2. Deployment key ships **embedded at compile time** via a `DeploymentKey.cs` generated from an env var during `dotnet publish` (documented in `INSTALL.md`; never checked into git). Fallback: read from `%ProgramData%\ConnectLive\deployment.key` if present, so ops can rotate without rebuilding.
3. Keep the 5s→60s back-off. Enrollment failures follow the same curve.

## Agent changes (`agent/src/`)

1. **Remove `JoinWindow` PIN prompt path** on startup — Agent now assumes the Watcher has already enrolled the device. If `device.dat` is somehow missing when the Agent launches, show a single "This device is not enrolled. Contact your administrator." dialog and exit; do not offer a code field.
2. Curtain Mode overlay + Live Session banner stay exactly as-is (compliance requirement).

## Admin panel changes

1. **`src/routes/_authenticated/console.tsx`** — remove any "Enter pairing code" affordance from device provisioning UI; devices now appear automatically the moment they heartbeat. Add a small "Auto-enrolled" badge on rows where `metadata.enrolled_via = 'deployment_key'`.
2. **Deployment Key management page** (super-admin `197200` only) at `/admin/deployment-key`:
   - Shows the current key's last-4 + created_at
   - "Rotate key" button → calls a protected server fn that regenerates `AGENT_DEPLOYMENT_KEY` and invalidates old value. Existing enrolled devices keep working (they use `device_token`, not the deployment key).
   - Copy-to-clipboard for the plaintext value (shown once, right after rotation).
3. No change to the Connect / Live-view flow — admin still clicks Connect, backend still creates the session row, Watcher still spawns the Agent via `LaunchInSession`.

## Security guardrails (per your note)

- No process-hiding, no Task Manager cloaking, no anti-uninstall hooks. Standard Windows Service semantics only.
- Deployment key is treated like a bearer secret: HTTPS only, never logged, timing-safe compare, rotatable.
- Per-IP enroll rate limit (5 attempts / hour) + audit trail.
- Device tokens remain per-device and revocable from the admin panel (existing "Delete device" flow already invalidates them).

## Deliverables

- Migration: add `enrolled_via` convention (no schema change — stored in existing `metadata` jsonb) + `login_attempts`-style rate-limit reuse.
- Code: enroll route rewrite, deprecated pair route, Watcher enroll path, Agent PIN removal, deployment-key admin page, key rotation server fn.
- `AGENT_DEPLOYMENT_KEY` generated via `generate_secret`.
- Rebuilt `ConnectLiveAgent.zip` with embedded/loadable deployment key wiring and updated `INSTALL.md`.
