
# Double-Vouch Architecture + Production Hardening

Persistent heartbeat (Watcher, SYSTEM) + persistent live session (Agent, user desktop), designed to survive Windows reboots, boot-time network latency, and mid-session crashes — plus real-time "Device connected" alerts in the admin panel.

```text
┌────────────────────── ADMIN BACKEND ──────────────────────┐
│  /agent/heartbeat  ◀── control plane                      │
│  /agent/session/*  ◀── data plane (WebRTC + HTTPS frames) │
│  notifications (Realtime broadcast)                       │
└────────▲───────────────────────────────▲──────────────────┘
         │ (1) Heartbeat 5-15s           │ (2) Live session
┌────────┴───────────┐            ┌──────┴───────────────┐
│ ConnectLiveWatcher │── spawns ─▶│  ConnectLiveAgent    │
│ (SYSTEM service)   │            │  (interactive user)  │
└────────────────────┘            └──────────────────────┘
```

## 1. Backend — heartbeat becomes reconnect-aware

`src/routes/api/public/agent/heartbeat.ts`
- Read current `status` and `last_seen_at` before updating.
- Compute `wasOffline = status !== 'online' OR (now - last_seen_at) > 60s`.
  Timestamp-delta catches reboots even when the row is still stale-marked `online`.
- Update `status='online'`, `last_seen_at=now()`.
- Compute `is_session_active` = exists `sessions` row for this device with `state IN ('invited','consented','active','paused')`.
- Return `{ ok, is_session_active, sessions }`.
- If `wasOffline`, insert into `notifications` (recipient_id NULL = broadcast) titled `Device reconnected`, body `${display_name} (${device_id}) is back online`.

No schema migration needed for the flag/toast — reuses existing tables.

## 2. Realtime for the toast

Migration: `ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;`

## 3. Watcher — infinite retry with exponential back-off + session supervision

`agent/watcher/Program.cs` (WatcherService.ExecuteAsync)
- Read shared identity from `%ProgramData%\ConnectLive\device.json`.
- Loop forever (never exits on network error — solves boot "no IP yet"):
  - `POST /api/public/agent/heartbeat` with `X-Device-Id` + `X-Device-Token`.
  - On success: cadence = **5s**; parse `is_session_active`.
    - If true and no `ConnectLiveAgent.exe` in the active console session → `LaunchInSession` (existing helper).
    - If false → leave agent alone (may be mid-consent).
  - On failure: exponential back-off **5s → 10s → 20s → 40s → 60s cap**; reset to 5s on first success.
- Keep existing user-switch detection and always-spawn-on-login behavior; the session-flag path is additive (revives agent if user closed it or it crashed).

## 4. Agent — tighter heartbeat cadence

`agent/src/Agent.cs`
- Healthy heartbeat cadence 30s → **15s** so the 60s delta check reliably distinguishes "alive" from "rebooted".
- Keep existing exponential backoff on failure and dead-man curtain-release.

## 5. `%ProgramData%\ConnectLive` ACL lockdown

`agent/install.ps1` (`Do-Install`, after `New-Item ... $DataDir`):
- Disable ACL inheritance on `$DataDir`.
- Explicit ACEs:
  - SYSTEM → FullControl
  - Administrators → FullControl
  - Interactive Users → Read only (needs consent.flag; must not overwrite token)
- Applied via `Get-Acl` / `SetAccessRuleProtection($true,$false)` / `SetAccessRule` / `Set-Acl`.
- Add a one-liner to `agent/INSTALL.md` noting the elevated install is what applies the ACL.

Standardize shared identity on `%ProgramData%\ConnectLive\device.json` (SYSTEM-writable, user-readable). If the agent still writes to `%AppData%`, add a one-time watcher-side copy on first successful heartbeat.

## 6. Admin panel — live "Device connected" toast

`src/routes/_authenticated/console.tsx` (and where `NotificationBell` lives):
- Subscribe to Supabase Realtime on `notifications` where `recipient_id IS NULL OR recipient_id = auth.uid()`.
- On INSERT with title `Device reconnected`, fire a `sonner` toast with the body text.
- Bell badge count updates for free (same table).

## 7. Repackage

Rebuild `agent/` into `ConnectLiveAgent.zip` so the next download ships:
- Watcher with back-off + session-flag supervision
- Agent with 15s heartbeat
- Installer with ACL lockdown

## Technical notes

- No EV cert required. The boot-time reconnect problem is pure network-latency, solved by the infinite loop.
- `is_session_active` is server-computed from `sessions.state` — no new column.
- RLS on `notifications` already allows broadcast reads (`recipient_id IS NULL`), so admins receive toasts without policy changes.
- 60s delta threshold sits comfortably above the 15s cadence + normal jitter, so healthy machines never false-fire.

## Out of scope

- Server-side offline sweeper (delta check makes it optional).
- WebRTC signaling changes.
- UI redesign.
