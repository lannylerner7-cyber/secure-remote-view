# ConnectLive — Precision, Resilience & Service Architecture

Three targeted upgrades to bring the agent to commercial-grade RMM behavior, without dropping any existing feature (curtain mode, standing consent, shared note, on-screen keys, trackpad, pairing flow, RBAC, Telegram, frame stream).

---

## 1. Mouse Mapping — Normalized Coordinates + VirtualDesk

**Admin (`src/routes/_authenticated/admin.tsx`)**

- Replace pixel-based click/move payloads with normalized `xPercent` / `yPercent` (0–1) computed against `img.getBoundingClientRect()`, accounting for the existing letterbox math.
- Trackpad keeps relative deltas but also normalizes to `-1..1` of the frame width/height so agent-side scaling is consistent.

**Agent (`agent/src/InputRelay.cs`)**

- New `MapToVirtualDesk(double xPct, double yPct)` helper:
  - Reads `SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN / SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN`.
  - Absolute px = virtual origin + pct * virtual size.
  - Normalizes to 0–65535 for `MOUSEINPUT`.
- `SendInput` called with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE` so multi-monitor works.
- Click / mousedown / mouseup / wheel reuse the same mapping.

Existing `ScreenCapture.cs` already draws the OS cursor into frames — untouched.

---

## 2. Network Resilience

**Agent (`agent/src/ApiClient.cs` + `Agent.cs`)**

- Heartbeat loop: exponential backoff 1s → 2s → 4s → 8s → 16s → 30s cap; reset to 1s on first success. Never throws out of the loop.
- Consecutive-failure counter; on **3 failures** call `InputBlocker.Release()` and `CurtainOverlay.Hide()` — dead-man fallback independent of the existing 5s curtain heartbeat.
- Frame POST and input-poll wrapped in try/catch with the same backoff, no crash on transient 5xx / DNS / TLS errors.

**Admin (`admin.tsx`)**

- Reconnect banner already exists for offline devices; add a "last frame age" indicator (green <2s, amber <8s, red otherwise) so admin sees stream health at a glance.
- Curtain pinger keeps its 1s cadence; if two pings fail, show a toast "Curtain link degraded — releasing in Ns".

**WebRTC note:** current live path is frame-based over HTTPS+Realtime, not WebRTC. The `iceconnectionstatechange` recipe doesn't apply until we migrate to WebRTC (out of scope this pass — noted for a later card).

---

## 3. Watcher / Worker Service Split

Session-0 isolation blocks screen capture and `SendInput` when running as SYSTEM. Split the agent into two binaries in the same solution.

**New: `agent/src/Watcher/**` (`ConnectLiveWatcher.csproj`, WinExe → installed as service)

- Runs as `LocalSystem`.
- Responsibilities: install/uninstall as Windows Service (`sc create ConnectLiveWatcher`), heartbeat to `/api/agent/heartbeat`, self-update check, spawn worker.
- On session-start signal or on user login: `WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` → `DuplicateTokenEx` → `CreateEnvironmentBlock` → `CreateProcessAsUser` launches `ConnectLiveAgent.exe` in the interactive session with elevation inherited.
- Watches the worker PID; respawns on crash with capped backoff.

**Existing agent → `agent/src/Worker/**` (renamed `ConnectLiveAgent.exe`)

- Same code we already have: splash, Join window, screen capture, input relay, curtain overlay, shared note, session indicator.
- Removes its own heartbeat responsibility (moved to Watcher) but keeps session/pairing calls.
- IPC with Watcher via a named pipe (`\\.\pipe\ConnectLive`) for: session-start push, curtain state, health.

**Installer (`agent/install.ps1`)**

- Copies both exes to `C:\Program Files\ConnectLive\`.
- Registers the Watcher as an auto-start service running as `LocalSystem`.
- Adds firewall rules and DPAPI-protected config in `%ProgramData%\ConnectLive\`.
- Uninstall script mirrors it.

**Manifests**

- Watcher: no UAC prompt (service).
- Worker: keep `requireAdministrator` in `app.manifest` so it inherits elevation cleanly from the Watcher token.

---

## Deliverables

- Updated `agent/` sources with the split + mapping + backoff.
- Refreshed `agent/INSTALL.md`: two build commands (watcher + worker), install.ps1 usage, dev-mode single-exe fallback for quick iteration.
- Refreshed `agent/ConnectLiveAgent.zip` at `/mnt/documents/ConnectLiveAgent.zip`.
- Admin: normalized coord payloads, stream-health indicator, curtain-degraded toast.

## Preserved (no removals)

Standing consent · pairing code flow · curtain mode + SetWindowDisplayAffinity · shared note overlay · resizable trackpad · slide-out on-screen keys · Telegram notifications · RBAC (`super_admin` / `admin` / `viewer`) · session recording hooks · draggable 190×30 indicator.

## Out of scope this pass

WebRTC migration (ICE restart hook) — current frame stream stays; we'll swap transport in a dedicated card once Watcher/Worker is stable.

## Technical notes

- Named-pipe ACL: only `LocalSystem` + the interactive user SID can connect.
- Token duplication: `TOKEN_ALL_ACCESS`, `SecurityImpersonation`, `TokenPrimary`.
- If no interactive session (`WTSGetActiveConsoleSessionId == 0xFFFFFFFF`), Watcher idles — no worker spawn on the lock screen.
- Dead-man releases are idempotent; safe to call from both the 5s curtain watchdog and the 3-fail heartbeat path.

&nbsp;

&nbsp;

&nbsp;

## ​One Minor "Gotcha" to Watch During Development

​**The Lock Screen (Secure Desktop) Transition:**

In your technical notes, you mention: *"If no interactive session (WTSGetActiveConsoleSessionId == 0xFFFFFFFF), Watcher idles — no worker spawn on the lock screen."*

​This is completely fine for this sprint, but be aware of how Windows defines a "Lock Screen":

1. ​If the computer is freshly booted and nobody has logged in, the Session ID is indeed 0xFFFFFFFF (or Session 0), and your Watcher will correctly idle.
2. ​However, if a user is logged in (Session 1) and presses Win + L to lock the PC, **the Session ID remains 1**. Instead of killing the session, Windows switches the active *desktop* from Default to Winlogon (the Secure Desktop).

​When this happens, your Worker (running on the Default desktop) will suddenly start capturing black frames, and SendInput will fail because it cannot pierce the Secure Desktop. For this sprint, simply handle the black frames gracefully. In a future sprint, you can update the Worker to use OpenInputDesktop and SetThreadDesktop to jump between the user's desktop and the lock screen.