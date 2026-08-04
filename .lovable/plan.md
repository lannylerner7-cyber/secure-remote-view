# Why native admin live video can fail to start — and the fix

Read of `PROJECT-MAP.md` plus a line-by-line trace of the admin render path
(`WebRtcClient` → `VideoPipeline` → `FrameConvert` → `D3DImageHost`), the agent
side (`WebRtcSession.cs`) and the signalling routes.

## What is NOT broken (ruled out by reading, no action)

- Offer direction: admin offers (`WebRtcClient.cs:160-170`), agent answers
  (`WebRtcSession.cs:484-530`) — matches ruling R1.
- Codec pin: admin declares VP8 pt96 RecvOnly (`WebRtcClient.cs:133-137`);
  agent pins VP8 and only pushes after `OnVideoFormatsNegotiated`.
- `Pipeline.Start()` is unconditional (`WebRtcClient.cs:84`); track + both RTP
  hooks wired before negotiation; signal polling starts on both sides
  immediately; JPEG fallback pump always starts and self-disables on
  `NativeVideo`.
- `IsPresenting` gating of the pill is honest.

So there is no categorical wiring bug. Video failing to start is one of four
concrete, code-level holes.

## The four real causes, ranked

### 1. Decoder death is permanent and invisible (highest confidence)

`VideoPipeline.DecodeLoop` (`VideoPipeline.cs:186-193`) constructs
`VpxVideoEncoder` inside the worker thread. If the native libvpx binding is
missing or mismatched on the technician's machine it logs one line and
`return`s — the decode thread is gone for the whole session. `Submit()` keeps
queueing, `_lastDecodedMs` never advances, so the stall watch fires PLI every
500 ms forever, which escalates into ICE restarts and, ~1 minute later, a
surrender to JPEG. The technician sees "video never started / it's laggy", and
the true cause never reaches the UI.

Fix: hoist decoder construction out of the loop into a guarded init that sets a
`DecoderFailed` state; on failure raise a `NativeVideoUnavailable` event, skip
the stall watch/PLI storm entirely, demote to the JPEG pump immediately, and
surface `decoder unavailable` in the stats pill instead of a generic stall.

### 2. Unrecognised decoder output is a silent infinite drop

`FrameConvert.Classify` (`FrameConvert.cs:24-32`) only accepts exact `w*h*4`,
`w*h*3`, `w*h*3/2`. Any padded-stride or NV12 output from a different
SIPSorceryMedia build fails every frame; `VideoPipeline.cs:233-238` counts the
error but — unlike the exception path — never requests a keyframe and never
gives up, so it too converges on the PLI/ICE-restart storm.

Fix: after N consecutive conversion failures, treat it exactly like cause 1
(stop the PLI loop, demote to fallback, report the observed byte length and
geometry once), and add NV12 to `Classify` since it shares the 3/2 size class
and can be distinguished only by an explicit format hint from the sample.

### 3. The D3D device is bound to the wrong window

`D3DImageHost.GetFocusWindow()` uses `Application.Current.MainWindow`
(`D3DImageHost.cs:148-161`). In this app `MainWindow` is the login window then
the device list (`App.xaml.cs:115,159`) — it is **never** reassigned to
`LiveSessionWindow`. So the D3D9Ex device is created against a window that is
not doing the presenting. This is tolerated by the code, but on several
driver/compositor combinations it is exactly what produces a black or frozen
`D3DImage` while `PushBgra` keeps returning true — "connected, pill says native
video, picture never appears".

Fix: let the presenting window supply its own hwnd. `LiveSessionWindow` passes
its `WindowInteropHelper` handle down to the pipeline/host at construction;
`GetFocusWindow()` uses that when set and only falls back to `MainWindow` /
desktop when it isn't.

### 4. No TURN relay unless the gateway is configured

`api/public/agent/ice.ts:49-126` returns an empty TURN list when neither the
Cloudflare Calls pair nor the coturn vars are set, and both peers then silently
run STUN-only. On symmetric NAT or filtered corporate egress ICE never
completes and the session lives on JPEG forever. Also, the roadmap contradicts
itself: §S9 says TURN is CLOSED, while the Backlog (`PROJECT-MAP.md:579,604`)
still lists "ICE gateway + TURN" as the next Tier A item.

Fix: no new transport code — log the resolved ICE server set once per session
on both peers, show `relay/srflx/host` in the stats pill when known, warn
loudly in the admin log when zero TURN servers came back, and correct the
Backlog entry so triage isn't sent the wrong way.

## Files to change

- `admin/src/Media/VideoPipeline.cs` — decoder init hoist + `DecoderFailed` /
  `NativeVideoUnavailable`, consecutive-conversion-failure give-up, stall watch
  suppressed once native video is declared dead.
- `admin/src/Media/FrameConvert.cs` — NV12 handling + richer failure detail.
- `admin/src/Media/D3DImageHost.cs` — accept an explicit presenting hwnd.
- `admin/src/Views/LiveSessionWindow.xaml.cs` — supply that hwnd.
- `admin/src/ViewModels/LiveSessionViewModel.cs` — surface
  `decoder unavailable` / `no TURN` in the pill and demote to JPEG at once.
- `admin/src/Media/WebRtcClient.cs` — log the resolved ICE server set; don't
  escalate ICE restarts when the failure is decode-side, not transport-side.
- `PROJECT-MAP.md` — record these as S16 and fix the S9 backlog contradiction.

No agent-side, web-side or database changes.
