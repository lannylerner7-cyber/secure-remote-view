## Goal

Verify — not rewrite — that everything landed by the recent video/signaling/database work is consistent across the three code bases (Windows Agent, native Admin console, web app + API) and that nothing drifted.

## What I found already (needs attention)

- `agent/src/ConnectLiveAgent.csproj` is still `1.8.0` and `admin/src/ConnectLiveAdmin.csproj` is still `1.6.0`, even though the last packaging step described v1.9 Agent / v1.7 Admin. Version metadata and the shipped installers are out of sync.
- The site currently exposes no download link for either client package (no zip referenced anywhere in `src/`), so the published page cannot hand out the latest builds.

## Verification plan

### 1. Agent client side

- Re-read `ScreenCapture.cs`, `DxgiCapture.cs`, `WebRtcSession.cs`, `Agent.cs` and confirm, line by line: even-dimension enforcement, BGRX→RGBA swap, `RowPitch`-aware row copy, VP8 verification before track start, `PushFrame` buffer-length guard, 10s idle heartbeat.
- Confirm every API path the agent calls exists in `src/routes/api/public/agent/` (enroll, hello, heartbeat, frame, cursor, inputs, signal, consent, reconnect, power ack, stream).
- Confirm the standalone story is intact: no updater/watcher references, startup self-heal present, no tray/session-indicator remnants.

### 2. Admin client side

- Re-read `WebRtcClient.cs`, `LiveSessionViewModel.cs`, `RealtimeChannel.cs`, `FrameFallbackPump.cs`, `CursorPollPump.cs`, `InputCoalescer.cs`.
- Confirm the RTP liveness watchdog is wired to the transport label, that fallback pumps stop when video recovers (no double-render), and that STUN-only server list matches the agent's.
- Confirm icon, config, and auth/bearer flow are consistent with the web API.

### 3. Web console + API

- Re-read `src/lib/webrtc-live.ts` watchdog + `iceRestart` path and the console transport pill states.
- Run `scripts/verify-agent-routes.ts` and `scripts/verify-payment-routes.ts`.
- Run `scripts/e2e-smoke.ts` and `scripts/e2e-wake.ts` and read the full output, including the Realtime-vs-REST delivery result flagged last time.

### 4. Database

- Re-check `session_frames` replica identity, the power-command index, and RLS/grants on every table the three clients touch; list any column that is written but never read so we can decide on cleanup separately (no drops in this pass).

### 5. Fix-ups produced by the sweep

- Bump `ConnectLiveAgent.csproj` to 1.9.0 and `ConnectLiveAdmin.csproj` to 1.7.0, and align the Inno/WiX version strings.
- Fix only defects the sweep actually finds; anything larger gets reported back to you rather than silently changed.

### Technical notes

No new transport, no TURN, no architecture change: STUN-only stays as the baseline. This pass is read-verify-then-patch-minimal. and output correct sanitised both admin and agent zip file