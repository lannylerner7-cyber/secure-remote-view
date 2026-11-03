# Implementation follow-through

The findings below describe the pre-implementation review. The Agent 1.10.1
changes and remaining acceptance gates are tracked in
[agent-lifecycle-implementation.md](agent-lifecycle-implementation.md) and
[agent-windows-verification.md](agent-windows-verification.md). These source
changes do not establish Windows reliability or authorize native Admin cutover.

# Agent ↔ browser lifecycle and curtain review

Date: 2026-11-03. Source baseline: `3a94974`.

This is a source audit and implementation plan, not a Windows runtime result.
No endpoint commands, deployment, database changes or secret changes were made.
The requested workflow is **not fully connected yet**. Native Admin stays available.

## 1. Current communication path

```text
Web admin ── HTTPS ──► authenticated session / authorization / signaling
Agent    ◄── HTTPS SSE wake + HTTPS heartbeat ── backend
Agent    ── DXGI or GDI capture → software VP8 → WebRTC ──► browser video
                                    direct ICE or TURN relay
Browser  ── ordered WebRTC input channel ──► authorized Agent input processing
Watch    ── HTTPS beacon ──► backend; then local Process.Start when authorized
```

HTTPS is the setup/presence path, not one request per video frame. DXGI is a
capture mechanism; it does not make the browser VP8 encoder hardware-accelerated.
Clipboard and files use separate data channels. That separation is useful, but
does not prove CPU, bandwidth or glass-to-glass latency under load.

Source timing, **not measured latency**:

- Agent heartbeat: approximately 5 seconds with an active session, 10 seconds
  while idle without healthy SSE, 60 seconds while idle with healthy SSE.
- SSE currently polls `power_commands` for `wake_agent` once per second on the
  server. It is not a zero-delay event-driven broker. Keepalive is about 15 seconds.
- Native RTC signaling has a 500 ms poll delay.
- Console inventory refresh is 5 seconds. Watch is scheduled once per minute.
- Heartbeat failure ends the local live session and retries presence with
  exponential backoff, capped at 30 seconds. This needs testing with transient
  HTTP failures while the media connection itself is still healthy.

References: `Agent.cs:250–350`, `WebRtcSession.cs` signaling loop,
`StreamListener.cs`, `src/routes/api/public/agent/stream.ts`, `webrtc-live.ts`.

## 2. Pairing and remaining prompts

The ordinary fresh path is one pairing window: enter code, review organization/
permissions, then **Pair & authorize**. Startup/recovery is an unchecked choice
on that same page. It is not automatically enabled merely by possessing a code.

A valid **unattended** grant avoids recurring session prompts. Attended mode
still asks for acceptance, as selected at enrollment. The old authorization
window remains for missing/mismatched/disabled local records and explicit
“Review authorization”; it is not removed from the source.

One-time pairing establishes enrollment and a device-scoped credential. It
must not become a permanent replayable pairing password. Watch already uses
stored device credentials and a matching current grant, not the old code.
Persistent enrollment/presence is distinct from a permanently active sharing
session: End sharing must stay ended, and a revoked grant must stay revoked.

If the product needs codes reserved for a particular named physical machine,
specify that binding separately; single-use redemption alone is not hardware
attestation.

References: `PairingPrompt.cs:34–96`, `App.xaml.cs:118–180`,
`Agent.cs:573–581`, `CompanionAuthorization.cs`.

## 3. Confirmed gaps

| Finding | Current code / consequence |
| --- | --- |
| Healthy idle devices can look stale | `console-types.ts` uses 30 seconds for stale and 75 seconds for offline; the Agent can legitimately wait 60 seconds between idle heartbeats. Do not equate this UI transition with a broken media connection. |
| Web Restart is not an end-to-end relaunch | `bulkRestartAgent` queues `restart_agent`; the active heartbeat loop does not call the retained `DispatchPowerCommands` method. Watch does not consume that queue. |
| Reconnect is a different action | `restartStream` replaces the browser viewer attempt. It does not start a stopped Windows process. |
| Watch cannot receive an instant web request | It is a scheduled, short-lived executable, not a resident command listener. A running process is ignored; an absent process may be relaunched after fresh authorization. |
| Watch launch is not verified health | `Watch/Program.cs` treats a non-null `Process.Start` as success. Exceptions return exit code 1, without an acknowledged console failure report or launch-health check. |
| Uninstall evidence is incomplete | Beacon accepts `uninstalling`, but the reviewed installer paths do not call it. Inno calls `/disable`; MSI removes a legacy task. The beacon stores both stopped and uninstalling as `status: stopped`. |
| Beacon can acknowledge failed writes | Supabase update/notification results are awaited without checking their returned `error`. An `ok: true` response is not proof that inventory/notification writes succeeded. |
| Stop cause is overstated | Beacon notification text says “terminated”; absence alone does not establish crash, Task Manager action or uninstall. “Uninstalling” also is not proof of completed removal. |
| SSE health is incomplete | HTTP connection success sets `Healthy`; there is no keepalive-age deadline in the inspected reader. Clearing health after stream loss does not itself interrupt an already-running idle heartbeat wait. |
| Wake-query failures can be silent | SSE destructures `data` but does not inspect the Supabase query error. Keepalives can therefore continue without successful command polling. |
| Browser curtain is unavailable | `WebRtcSession.Actions.cs:45–47` rejects `curtain_on` for video-only sessions. The console explicitly says privacy curtain is unavailable in this protocol. |

Do not “fix” relaunch by restoring the entire generic power dispatcher. That
would also expose unrelated operations. Add a narrowly authorized lifecycle
command instead.

## 4. Existing curtain implementation: intent versus proof

The legacy implementation already attempts the requested local presentation:
`CurtainOverlay.cs` creates a centered maintenance card on a dimmed, topmost
window for **every attached monitor**, and calls
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. It is not an admin-side
overlay. It fails and hides the windows when Windows rejects exclusion.

However, it is not yet verified as the requested browser feature:

- Browser video-only dispatch blocks activation.
- Local input is engaged before the overlay's asynchronous UI operation.
  Blocking must not be acknowledged before a visible, working banner.
- The window is shown before capture exclusion is applied. Check/fix the
  possible first-frame banner leak; API success alone is not captured-frame proof.
- Raw monitor bounds are assigned to WPF window coordinates. Mixed-DPI,
  negative-origin and rotated monitor coverage require actual Windows checks.
- The input watchdog is checked by the input pump. It needs an independent
  release path if that pump stalls, not just a check after the next action.
- The current five-second lease is refreshed by repeated `curtain_on` messages.
  Browser activation needs an explicit ownership/renewal/status contract.
- The input hook allows input carrying **either** the Agent marker **or** an
  injected-input flag. That differs from comments suggesting only Agent-marked
  injection is allowed. Do not treat this filter as an OS security boundary.
- The banner promises Ctrl+Alt+Del recovery. Source session-switch handlers
  are not proof that entering and leaving the secure-attention screen clears
  the curtain permanently. Test the actual local recovery path.
- Some comments still refer to BlockInput/elevation even though the blocker
  now uses low-level hooks. These are misleading troubleshooting instructions.

Required behavior: a visible local maintenance card, absent from the remote
video; normal local input paused while a valid curtain lease is active; remote
authorized input still usable; confirmed on/off state in the web console.
“Until toggled off” applies to a healthy authorized session—not an irreversible
lockout. Local emergency recovery, disconnect/lease expiry, revocation, process
exit and Windows security boundaries must release or override it.

## 5. Implementation order

### A. Make inventory and failures truthful

- Separate Agent presence, Watch presence, sharing state and installation
  evidence. Preserve the device inventory row rather than deleting it on silence.
- Align online/stale thresholds with the declared, server-bounded heartbeat
  cadence. A stale stream is not automatically an offline device.
- Use distinct states: Agent running, Agent stopped/Watch reachable, reconnecting,
  offline/unknown, locally disabled, uninstalling reported, uninstall completed
  reported. Give each a timestamp and evidence source.
- Check database errors; report failures accurately. Sequence/instance-bind
  events so a delayed stopped beacon cannot overwrite a newer running state.
- Report launch attempt, process started, healthy heartbeat, timeout and failure
  separately. Store bounded, credential-free failure details for later delivery
  when the network is unavailable.

### B. Add an explicit, low-overhead Watch control channel

- For prompt web relaunch, the opted-in Watch companion must be independently
  reachable while Agent is absent. Use one authenticated outbound persistent
  channel with backoff/jitter and a limited fallback—not per-second heavy queries.
- Authenticate it with the enrolled device identity, not a reused pairing code.
  Authorize both the requesting technician and current device/local startup choice.
- Allow only the specific Agent lifecycle operation, with command ID, expiry,
  instance binding, deduplication and status receipts:
  `requested → received → starting → healthy`, or `rejected/expired/failed`.
- Check executable identity/path, the existing process mutex, update state and
  withdrawal again before launch. Do not start a duplicate, re-enroll silently,
  relaunch after local disable or reinstall after uninstall.
- Detect the managed process exiting without waiting only for the scheduled
  minute. Avoid repeated crash loops; expose a bounded retry/failed state.
- Remove or correct the old web Restart action until this receiver is connected.
  Keep “Reconnect viewer” visibly separate.

If Agent **and** Watch are stopped, or the computer/network is down, a web
request alone cannot execute locally. Show unavailable/pending honestly; do
not claim that an HTTP request can wake an absent listener.

### C. Connect browser curtain as an acknowledged capability

- Negotiate support and enforce the recorded authorization. Include any new
  privacy/input-pause scope in the one-time enrollment disclosure; do not add
  recurring prompts to already-authorized unattended sessions.
- Implement explicit on/off/renew/status with session, grant, peer and lease
  ownership. Reject stale/competing technician requests.
- Establish capture exclusion and visible local presentation before input
  filtering. Report applied only after both operations succeed; undo both if
  either fails. No admin-video banner and no auto-engagement on ordinary control.
- Keep the release timer independent of capture, encoding, file transfer and
  queued input. Local release/withdrawal always wins.
- Add the web button only when the Agent advertises supported capability.

### D. Measure and improve connection/rendering

- Trace request → wake → invite → offer/answer → selected ICE pair → first capture
  → first encoded frame → first decoded/presented frame.
- Measure first-frame and steady-state glass-to-glass separately; RTT is not
  display latency. Record median/p95, dropped frames, capture/encode time and CPU.
- Test direct and forced TURN, DXGI and GDI, packet loss, HTTP interruption,
  browser refresh/backgrounding and simultaneous authorized transfers.
- Use bounded/latest-frame capture buffers, bounded command queues and fair
  work scheduling. Do not parallelize conflicting key/mouse/session mutations.
- Make SSE liveness time-based, wake the fallback loop on failure and inspect
  database errors. Replace per-device database polling with authorized event
  delivery before claiming fleet-scale efficiency.

## 6. Required Windows proof

Use a designated disposable Windows device—not an arbitrary production endpoint.
For each check record actual build/hash, OS/browser, selected ICE candidate
types and decoded-frame evidence, omitting credentials/full SDP/raw network dumps.

1. Fresh pairing and restart: one enrollment flow; valid unattended sessions
   have no repeated prompt; withdrawn/changed authorization is not bypassed.
2. Task Manager termination: Watch reports absence, relaunch is acknowledged,
   one Agent becomes healthy. Repeat with network loss and a launch failure.
3. Local Disable and uninstall: neither Watch nor queued admin commands revive
   access. An offline uninstall remains unknown until trustworthy evidence exists.
4. Curtain: inspect physical displays and admin video simultaneously, including
   the first frame, all monitors, mixed DPI, portrait and DXGI/GDI fallback.
5. Curtain input: local input paused, authorized remote input works, actual local
   emergency recovery works; test disconnect, revocation, Agent crash, stalled
   input pump, locked desktop and competing viewers. No stuck keys.
6. Record real first-frame/steady-state latency and resource usage while files,
   clipboard and recording are also active.

No physical result in this matrix has been obtained in this audit. Do not
describe browser curtain, instant web relaunch, uninstall detection or Windows
media as production-verified until the corresponding evidence exists.
