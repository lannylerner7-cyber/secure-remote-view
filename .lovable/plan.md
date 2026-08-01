# Phase 1 — Rename, Strip Removal, Staged Wake, Admin Realtime

Scope note: service registration is **not** reopened. Wake stage 1 (updater-first) stays deferred to Phase 2.

## Status of already-shipped work

Item 1 (on-screen live strip removal + InputRelay re-gate) and the console.tsx staged Wake messaging were applied in the previous turn, and only the agent zip was refreshed. This plan finishes the remaining items and re-emits **both** archives so the admin side is not left behind.

Confirmed non-regression: `SessionBanner` was only used by `EngageCurtain()` for curtain stacking. The relay loop runs purely on `ct.IsCancellationRequested`, so remote input works with zero on-screen UI.

## 0. Watcher → Updater rename (whole repo)

| Now | After |
|---|---|
| `agent/watcher/` | `agent/updater/` |
| `ConnectLiveWatcher.csproj` | `ConnectLiveUpdater.csproj` |
| assembly `ConnectLiveService.exe` | `ConnectLiveUpdater.exe` |
| `IsWatcherServiceRunning`, `StreamLoop` log tags, `"watcher"` strings | updater equivalents |

Also updated: `build.bat`, `agent/build.ps1`, `agent/install.ps1`, `agent/packaging/inno/ConnectLiveSetup.iss`, `agent/packaging/msi/ConnectLive.wxs`, GPO/Intune/Jamf manifests, `agent/README.md`, `agent/INSTALL.md`, `AGENTS.md`, and admin/web user-facing strings ("Updater not running").

`InputBlocker.CheckWatchdog` keeps its name — genuine watchdog timer, not the updater. No registration logic is added or removed; existing behavior carries over under the new name.

## 1. Live strip removal — verification pass

Confirm no dangling references remain: `SessionIndicator.cs` deleted, `Agent.cs` `_indicator` sites gone, `CurtainOverlay.Show()` signature without banner, `App.xaml.cs` assignment removed, README row dropped, class comment in `InputRelay.cs` rewritten to the session-token + tray-quit kill switch story.

## 2. Wake — stages 2 and 3, admin side

Mirror the staged reporting already in `console.tsx` into `admin/src/ViewModels/DevicesViewModel.cs`:

```text
Wake pressed
  ├─ device ONLINE            → "Device is already online — use Connect."
  ├─ no lan_subnet_v4         → never reported a LAN subnet; must check in once online first
  ├─ subnet but no MAC        → names the missing field explicitly
  ├─ subnet + MAC, no peer    → needs another ConnectLive machine online on <subnet>
  └─ peer found               → queue relay WoL, report which peer relayed it
```

Surfaced inline in the device row, not a modal dead end. A **Wake** button is added to the admin device row so it is reachable without opening a session.

## 3. Admin console — raw Supabase Realtime rendering

- New `admin/src/Media/RealtimeChannel.cs` — Realtime WebSocket authenticated with the stored user access token; `postgres_changes` on `session_frames`, `session_cursors`, `session_signals`, filtered to the active `session_id`; reconnect/backoff and token-refresh handling.
- `FrameFallbackPump.cs` / `CursorPollPump.cs` become true fallbacks: idle while the socket is healthy, resume adaptive polling within ~2s of a drop.
- `LiveSessionViewModel.cs` accepts frames from whichever transport lands first, de-duplicated on `updated_at`; the WebRTC upgrade path is unchanged and still preferred.
- Button audit — `MainWindow.xaml` (Payments, Orders, Refresh, Sign out, Connect, Delete, new Wake) and `LiveSessionWindow.xaml` (view/control, curtain, power actions, restart stream, restart agent, reconnect, end session): each gets a bound command with correct `CanExecute`, busy state, and a visible success/failure result instead of a silent no-op.

## Technical notes

- Realtime prerequisite: additive migration adding `session_frames` and `session_cursors` to the `supabase_realtime` publication with `REPLICA IDENTITY FULL`. No RLS changes.
- Security rule preserved: no backend key or JWT is ever written to an agent/updater machine; agent/updater stay device-token SSE only.
- Deliverables: refreshed `ConnectLive-RemoteAgent-src.zip` **and** `ConnectLive-AdminConsole-src.zip`, emitted one after the other.

## Deferred to Phase 2

Wake stage 1 — updater receives the wake over device-token SSE, reads the last-used session id from `%ProgramData%\ConnectLive`, relaunches the Agent in the interactive session, acks `delivered`. Requires the updater installed as LocalSystem, which reopens service registration — done deliberately, not as a side effect.
