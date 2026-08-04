# Why live video never really starts — and what "4K-grade" actually needs

Traced the whole video path against the roadmap: web console (`webrtc-live.ts`),
native admin (`WebRtcClient` → `VideoPipeline` → `D3DImageHost`), agent
(`WebRtcSession`, `DxgiCapture`, `ScreenCapture`, `BitrateController`) and the
ICE gateway route.

Verdict: the negotiation wiring is correct on all three sides (admin offers,
agent answers, VP8 pinned both ways). Video "not starting" and "not 4K" are two
separate problems, and neither is a missing feature — they are five concrete
defects plus one deliberate design ceiling.

## Why video does not start

### 1. No TURN relay configured → JPEG forever on most networks

`api/public/agent/ice.ts:122-126` returns an empty TURN list unless the
Cloudflare Calls pair or the coturn vars are set; both peers then silently run
STUN-only. On symmetric NAT / corporate egress, ICE never completes and every
session falls back to JPEG — exactly the "blah blah JPEG" symptom. This is the
single most likely cause in the field, and today nothing in either UI says
"no relay". The roadmap even contradicts itself: S9 is marked CLOSED
(`PROJECT-MAP.md:354`) while the Backlog still lists TURN as unfinished
(`:579,604`).

### 2. Web console builds the peer before ICE arrives

`webrtc-live.ts:126` constructs `RTCPeerConnection` with the hardcoded
`STUN_SERVERS`, and only patches in the gateway set at `:407` via
`setConfiguration`. On browsers that have already begun gathering, the relay
candidates never make it into the offer, so the web path is STUN-only even when
TURN *is* configured.

### 3. Native admin: VP8 decoder death is permanent and invisible

`VideoPipeline.cs:186-193` creates `VpxVideoEncoder` inside the decode thread;
if the native libvpx dependency is missing it logs one line and `return`s. The
thread is gone for the session — frames queue forever, `_lastDecodedMs` never
advances, the stall watch fires PLI every 500 ms, that escalates into ICE
restarts, and a minute later it surrenders to JPEG. The technician sees "video
never started"; the real cause (no decoder) never reaches the UI.

### 4. Unrecognised decoder output is a silent infinite drop

`FrameConvert.Classify` only accepts exactly `w*h*4`, `w*h*3`, `w*h*3/2`. Any
padded-stride or NV12 output fails every frame; `VideoPipeline.cs:233-238`
counts it but never requests a keyframe and never gives up — same PLI storm,
same wrong diagnosis.

### 5. The D3D device is bound to the wrong window

`D3DImageHost.GetFocusWindow()` uses `Application.Current.MainWindow`
(`D3DImageHost.cs:148-161`), which in this app is the login window and then the
device list (`App.xaml.cs:115,159`) — never `LiveSessionWindow`. The D3D9Ex
device is therefore associated with a window that is not presenting. On several
driver/compositor combinations this is precisely what yields a black or frozen
picture while `PushBgra` keeps reporting success.

## Why it is not "4K-grade"

This part is not a bug — it is the current design ceiling, and the roadmap never
promised more:

- The agent downscales to a **1920 px max edge at the top rung**
  (`BitrateController.cs:46` — `1920, q70/85, 30 fps, 4000 kbps`), and
  `ScreenCapture.cs:101-118` even clamps to 1920x1080. So the best case today is
  1080p at 4 Mbps, resampled — soft on a 4K panel no matter how good the
  renderer is.
- The codec is **VP8, software-encoded**. `HwEncoderProbe.cs` exists but nothing
  consumes its result, so the NVENC/QuickSync H.264 path the roadmap sketched is
  never taken. Software VP8 at 4 Mbps cannot carry crisp 4K text.
- Going native (D3D) removed the *presentation* blur; it cannot recover detail
  the encoder already threw away.

Reaching a genuinely sharp picture means raising the source ceiling and the
encoder, in this order: unclamp capture to the real desktop size, add
2560/3840 rungs with 8-20 Mbps budgets, and switch to hardware H.264 when
`HwEncoderProbe` reports support (falling back to VP8 otherwise, with the pin
negotiated identically on both peers). This is how ScreenConnect/AnyDesk-class
products get there: relay-guaranteed transport first, hardware codec second,
dirty-rect + adaptive ladder third.

## What to change

**Make failures visible and stop the wrong self-heal**
- `admin/src/Media/VideoPipeline.cs` — hoist decoder construction out of the
  loop into a guarded init; on failure raise `NativeVideoUnavailable`, suppress
  the stall/PLI loop, demote to JPEG immediately. Same treatment after N
  consecutive conversion failures.
- `admin/src/Media/FrameConvert.cs` — accept NV12, report observed byte length
  and geometry on mismatch.
- `admin/src/Media/WebRtcClient.cs` — log the resolved ICE set; do not escalate
  ICE restarts when the failure is decode-side.
- `admin/src/ViewModels/LiveSessionViewModel.cs` — surface
  `decoder unavailable` / `no relay` in the stats pill instead of a bare stall.

**Fix the two hard defects**
- `admin/src/Media/D3DImageHost.cs` + `LiveSessionWindow.xaml.cs` — the
  presenting window supplies its own hwnd; `MainWindow` only as fallback.
- `src/lib/webrtc-live.ts` — await the ICE gateway before constructing the peer
  connection; keep `setConfiguration` only as a late top-up. Show a "relay
  unavailable" note in the console when `turn:false`.

**Close the relay gap**
- No new transport code: confirm `CLOUDFLARE_CALLS_APP_ID` /
  `CLOUDFLARE_CALLS_APP_TOKEN` are set as secrets, and warn loudly in both
  consoles when the gateway returns zero TURN servers.
- `PROJECT-MAP.md` — fix the S9 contradiction, record the above as S16.

**Raise the quality ceiling (S17, larger)**
- `agent/src/ScreenCapture.cs` / `DxgiCapture.cs` — remove the 1920x1080 clamp,
  capture at native desktop resolution.
- `agent/src/BitrateController.cs` — add 3840 and 2560 rungs with 20/12 Mbps
  budgets above the current top rung.
- `agent/src/WebRtcSession.cs` + `HwEncoderProbe.cs` — negotiate H.264 when a
  hardware encoder is present, VP8 otherwise; the admin must advertise both and
  pin whichever the agent selects.

## Sequencing question

S16 (visibility + the two defects + relay) is small and makes the current
failure explainable within one session. S17 (native-resolution capture +
hardware H.264) is the one that actually delivers a sharp 4K picture and touches
codec negotiation on both peers. I'd ship S16 first so S17 is debuggable, but
they can go together if you'd rather have one build.
