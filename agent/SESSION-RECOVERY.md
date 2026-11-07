# Live session, control and pairing recovery — Agent 1.10.8

## Evidence from the reported Windows run

The 1.10.7 log establishes successful H.264 negotiation, connected WebRTC,
an open input channel, an initialized Intel Quick Sync encoder and increasing
encoded output. Later, encoded output remains at 103 while submitted frames
continue increasing. The peer closes afterward. Successful heartbeats appear;
this log does not establish a heartbeat timeout as the cause of this freeze.
There is no successful curtain-application receipt in the supplied excerpt.

The VP8 prerequisite problem still exists on that computer: the native asset
matches the process architecture, but the separate VCRUNTIME140 load fails.
This does not prevent the independently working H.264 path from being used.
Use the official repair guidance in VIDEO-DEPENDENCIES.md for VP8; no runtime
is installed by this source.

## Corrections

- Preserve asynchronous Media Foundation input credits across Encode calls.
  The previous loop discarded a second NeedInput event after submitting one
  frame. This can exhaust the driver's input credits and leave an apparently
  live encoder producing nothing. Empty event queues now return immediately,
  rather than busy-spinning for 120 ms.
- Preserve separate output access units. Do not merge several async output
  samples into one RTP frame.
- Detect sustained empty output only while frames are being submitted.
  Attempt at most two encoder rebuilds inside the existing authorized H.264
  peer, forcing a fresh keyframe. Persistent failure still triggers explicit,
  bounded viewer recovery rather than an infinite driver-reset loop.
- Do not permanently exclude H.264 when VP8 is unavailable. The browser also
  gives a briefly successful codec one same-path retry before changing
  profiles. Neither mechanism changes session authorization.
- Keep the local curtain opaque; verify Windows capture exclusion again after
  WPF renders and before pausing local input. Do not fall back to GDI capture
  while that curtain is still visible. Release it first if DXGI becomes
  unavailable. Keep the emergency exit and bounded curtain lease.
- A matching authenticated `session_status` receipt with `state: ended`
  stops remote access and opens the single pairing-code screen. This pending
  requirement survives process restart and blocks background recovery.
  Only successful, explicitly accepted foreground pairing clears it.
- Missing rows, empty session lists, video disconnects, paused sessions,
  wrong-session/wrong-grant receipts and HTTP failures do not request a new
  identity. Existing credentials are not erased by those events.

Microsoft's contract requires one ProcessInput call per NeedInput event and
one ProcessOutput call per HaveOutput event:
https://learn.microsoft.com/en-us/windows/win32/medfound/asynchronous-mfts

## Server compatibility

The Agent sends `observed_session_id` with its heartbeat. The updated server
returns `session_status` only for that authenticated device, session and current
authorization. An optional status-lookup outage yields no terminal receipt,
not a fabricated end or an interruption of otherwise verified live authority.
No database migration is required.

This ZIP contains client source, **not a deployed web server**. The source
workspace's web changes must be running at the Agent's gateway origin.
Startup prints that origin. An older published server will not provide the
new terminal receipt. A different origin requires its own pairing.

## Verification boundary

Portable tests exercise the real async input-credit pump for 1,800 frames,
bounded output recovery, terminal-receipt matching and native wrapper
compilation. They do not execute Media Foundation, WPF or native input hooks.
Web checks cover recovery profiles, control/curtain receipt order, cancellation,
rollback, release, private logging and authenticated terminal-status isolation.

### Signed-in browser evidence — 2026-11-07

The test used a disposable administrator and synthetic device, real invitation
and consent endpoints, real signaling and genuine browser WebRTC with an
animated canvas track. It did not operate a customer device.

- During the 60-second observation ending at 21:58:35.971 UTC, H.264 video
  advanced to 77.0598 seconds and 773 presented video frames. The first
  one-second sample was 18.0598 seconds / 183 frames. Video readyState
  remained 4; decoded counters increased, with zero reported packet loss.
  Fourteen presentation-frame drops were reported at the last sample.
- Take control + curtain waited for the Agent's matching permission status
  after the server changed the session to control. Only then did the
  acknowledged curtain action enable the ready state. Applied renewals
  continued for approximately 21 seconds while video continued.
- Release returned an applied curtain-off receipt, followed by view-mode
  heartbeat and permission status.
- One deliberate synthetic-peer disconnect recovered automatically:
  two offers total, exactly one replacement, a fresh input channel,
  unchanged session/grant, and no automatic curtain reactivation.
  Recovered video advanced from 292 to 317 frames in about 2.5 seconds.
- End sharing closed the viewer. An authenticated heartbeat returned the
  exact matching ended-session receipt required by the native pairing policy.

The initial test setup started its producer late and did not complete the
media/control assertions. The targeted continuation corrected that setup and
completed only the missing checks; it did not rerun pairing.

Separate unlock-status polling returned HTTP 503 when the disposable account
could not unlock the device. Those requests were not Agent signaling failures
and did not block the verified video/control flow. Optional Telegram delivery
was unconfigured. The fixture session was ended, helper stopped and test
account/device cleanup performed.

**Boundary:** Curtain receipts in this browser test were simulated by the
synthetic Agent. This is not evidence of Windows capture exclusion, hardware
encoding or physical keyboard/mouse behavior.

No Windows Agent/Admin executable, installer or MSI was built here.
No production deployment or GitHub push was performed. Native verification
must use the newly built source on the designated Windows test computer.
