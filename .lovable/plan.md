## Confirmations first (verified against live code + DB)

**1. Realtime migration — not needed at all.** Queried `pg_publication_tables` and `pg_class`: `session_frames` and `session_cursors` are *already* in `supabase_realtime`, and all three tables (`power_commands`, `session_frames`, `session_cursors`) already have `relreplident = 'f'` (REPLICA IDENTITY FULL). So there is **no DB change in this plan** — no ALTER PUBLICATION, no REPLICA IDENTITY, no RLS touched, `power_commands` untouched. Dropping the migration step entirely.

**2. Installer state — one correction to your assumption.**

- `agent/packaging/inno/ConnectLiveSetup.iss` — confirmed **current Phase 1**: header literally says "Agent only, no Windows Service", `[Run]` uses `runasoriginaluser`, no service code, no `ConnectLiveService.exe` reference. The rename will touch this current file only, and will **not** reintroduce service registration.
- `agent/build.ps1` — **not** Agent-only as you described. It still does `dotnet restore watcher/ConnectLiveWatcher.csproj`, publishes the watcher, stages `dist/ConnectLiveService.exe`, and hard-fails if that binary is missing. That is fine and intentional for Phase 2 (the binary must keep building), so I'll rename it in place rather than strip it. Flagging it so the discrepancy isn't a surprise.
- `agent/packaging/msi/ConnectLive.wxs` — still full service install (`ServiceInstall`, `ServiceControl`, firewall rule, SYSTEM ACLs). This is the Phase 2 MSI path and is **not** the Phase 1 installer; rename only, logic untouched.

**3. Service registration identifier stays stable.** The Windows service `Name` in the WXS is `ConnectLiveWatcher`. That identifier is **not** renamed — only display names, file/dir names, assembly name and code symbols change. A Phase 2 upgrade therefore replaces the same service entry instead of orphaning one.

---

## 0. Watcher → Updater rename


| Now                                                | After                       |
| -------------------------------------------------- | --------------------------- |
| `agent/watcher/`                                   | `agent/updater/`            |
| `ConnectLiveWatcher.csproj`                        | `ConnectLiveUpdater.csproj` |
| assembly `ConnectLiveService.exe`                  | `ConnectLiveUpdater.exe`    |
| code symbols / log tags / `"watcher"` strings      | updater equivalents         |
| **service registration Name `ConnectLiveWatcher**` | **unchanged**               |


Files updated: `agent/updater/Program.cs`, `build.bat`, `agent/build.ps1`, `agent/install.ps1`, `agent/packaging/inno/ConnectLiveSetup.iss` (comment lines only — it has no service code to break), `agent/packaging/msi/ConnectLive.wxs` (paths + display strings; `ServiceInstall/@Name` untouched), GPO/Intune/Jamf manifests, `agent/README.md`, `agent/INSTALL.md`, `AGENTS.md`, and admin/web user-facing strings ("Updater not running"). `InputBlocker.CheckWatchdog` keeps its name — it is a real watchdog timer, not the updater.

## 1. Remove the on-screen live strip (with InputRelay re-gate)

Re-confirming the answer to your must-not-regress question: `SessionBanner` (`InputRelay.cs:20`) is used in exactly one place — `EngageCurtain()` line 144, purely for curtain z-order stacking. The relay loop (line 32) already runs on `ct.IsCancellationRequested` alone, and curtain release is `ct.Register(...)` at line 27. Input is therefore already decoupled from any window; removing the banner cannot stop it.

- Delete `agent/src/SessionIndicator.cs`.
- `Agent.cs` — remove `_indicator` (line 29) and both construction sites (337, 367) plus `SetControlGranted` calls.
- `InputRelay.cs` — delete `SessionBanner`, simplify `EngageCurtain()`, rewrite the stale class comment (lines 12-16) that wrongly claims relay depends on the indicator being visible.
- `CurtainOverlay.cs` — `Show()` drops the banner parameter and its restacking.
- `App.xaml.cs` — remove the `InputRelay.SessionBanner = ...` assignment.
- `agent/README.md` — drop the SessionIndicator row.

Session transparency remains via the tray icon + tooltip.

## 2. Wake — stages 2 and 3 only (no updater wake)

`src/routes/_authenticated/console.tsx:319-331` dead-ends with "No online peer found on the same subnet…". Replacing with staged, precise reporting:

```text
Wake pressed
  ├─ device already ONLINE     → "Already online — use Connect."
  ├─ no lan_subnet_v4 recorded → "Never reported a LAN subnet, so Wake-on-LAN
  │                               can't be routed. It must check in once
  │                               while online first."
  ├─ subnet known, no MAC      → names the missing field explicitly
  ├─ subnet + MAC, no online peer
  │                            → "Powered-off wake needs another ConnectLive
  │                               machine online on <subnet> to broadcast the
  │                               packet. None is online right now."
  └─ peer found                → queue relay WoL, report which peer relayed
```

Mirrored in `admin/src/ViewModels/DevicesViewModel.cs`, surfaced inline in the device row; a **Wake** button is added to the admin device row. Stage 1 (ask the machine's own updater) is deliberately left unwired — Phase 2.

## 3. Admin console — raw Supabase Realtime rendering

Admin holds a real user JWT in `AuthStore`, so a direct socket is legitimate there; agent/updater stays device-token SSE only, no Supabase key on those machines.

- New `admin/src/Media/RealtimeChannel.cs` — Realtime WebSocket authenticated with the stored access token, `postgres_changes` on `session_frames`, `session_cursors`, `session_signals`, filtered to the active `session_id`, with reconnect/backoff and token-refresh handling. No migration needed — the publication and replica identity are already in place.
- `FrameFallbackPump.cs` / `CursorPollPump.cs` become true fallbacks: idle while the socket is healthy, resume adaptive polling within ~2s of a drop.
- `LiveSessionViewModel.cs` accepts frames from whichever transport lands first, de-duplicated on `updated_at`; the WebRTC upgrade path is unchanged and still preferred.
- Button audit — `MainWindow.xaml` (Payments, Orders, Refresh, Sign out, Connect, Delete, new Wake) and `LiveSessionWindow.xaml` (view/control, curtain, power actions, restart stream, restart agent, reconnect, end session): each gets a bound command with correct `CanExecute`, busy state, and a visible success/failure result instead of a silent no-op.

---

## Technical notes

- No database migration in this plan.
- Security rule preserved: no Supabase key or JWT written to any agent/updater machine.
- Deliverables: refreshed `ConnectLive.zip` and `ConnectLiveAdmin.zip`.

## Deferred to Phase 2

Wake stage 1 — updater receives the wake over device-token SSE, reads the last-used session id from `%ProgramData%\ConnectLive`, relaunches the Agent in the interactive session, acks `delivered`. Requires the updater registered as LocalSystem under the existing `ConnectLiveWatcher` service name.