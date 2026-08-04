# S17 — Real 4K live broadcast: hardware H.264, native-resolution capture, input priority

## What I verified first

- `agent/src/WebRtcSession.cs:176` restricts the encoder to VP8 and `:213` rejects any other negotiated codec. `HwEncoderProbe` results are never read by the session — the probe only logs.
- `agent/src/ScreenCapture.cs:33` takes `MaxEdge` straight from `BitrateController`, and `:205-206` downscales every frame to that edge. Top rung is 1920px / 4000 kbps, so best case today is 1080p, upscaled on the admin side.
- `agent/src/DxgiCapture.cs` already captures at true desktop size and tracks resize; the clamp is purely downstream in `ScreenCapture`.
- Admin decodes with libvpx (`VpxVideoEncoder`) and pins VP8 in `admin/src/Media/WebRtcClient.cs`.

So the three claims in the request are accurate as written.

## What live broadcast will actually feel like

Today: a 4K desktop is captured at 4K, squashed to 1920px, VP8-encoded in software at ~4 Mbps, then stretched back up on the admin. Text is soft because it was resampled twice and quantised at q70. The agent's CPU is doing the encode, so busy machines fall down the ladder and get softer still.

After the change:

- **Sharpness**: 1:1 pixels. A 3840 rung at ~20 Mbps with hardware H.264 makes small UI text readable without zooming — this is the single visible difference, and it is large.
- **Latency**: hardware encode removes the agent's dominant CPU cost, so frame pacing stops collapsing under load. Expect steadier 30fps rather than a lower floor number.
- **Agent load**: NVENC/QSV/AMF encode is near-free; the CPU graph on the endpoint drops sharply. On machines with no hardware encoder nothing changes — they stay on software VP8 at the current ceiling, by design.
- **Bandwidth**: this is the real trade. 20 Mbps sustained is a LAN/fibre number. On anything worse the ladder will step down to today's rungs within a couple of seconds, so the 4K rungs are a *ceiling raise*, not a new default — the experience on a bad link is unchanged.
- **Native admin stability**: decoding H.264 through Media Foundation removes libvpx from the admin entirely, which retires the S16 "decoder unavailable" failure mode rather than just reporting it better.

## My take

The ordering in the request is right and I would not reorder it. Two honest caveats:

1. **Capture unclamp is cheap and safe; codec swap is not.** Unclamping is a few lines and immediately visible. H.264 negotiation touches both peers, the web console, and the admin decode path, and a mistake there negotiates a stream nothing can encode — the exact failure the current hard pin exists to prevent. They must ship as separate, independently revertable steps.
2. **Hardware H.264 without an MFT wrapper is not usable.** `HwEncoderProbe` finds the encoder but nothing wraps it as a SIPSorcery `IVideoEncoder`. That wrapper is the bulk of the work in step 2, not the negotiation itself. Any plan that says "consume the probe" and skips the wrapper will fail at runtime.

Input prioritisation is worth doing but is the smallest of the three wins here: input already runs on a separate ordered datachannel, so it is not literally queued behind frames — the gain is bounded to bufferbloat under congestion.

## Plan

### Step 1 — Unclamp capture, add 2560 and 3840 rungs
- `agent/src/BitrateController.cs`: prepend `new(3840, 78, 90, 30, 20000)` and `new(2560, 74, 88, 30, 12000)` above the current top rung; keep 1920 as the third entry so existing behaviour is one step down, not gone.
- `agent/src/ScreenCapture.cs`: skip the resample entirely when `scale >= 1.0` (currently allocates and redraws even at 1:1); remove the hardcoded `1920x1080` fallback bounds at `:118` in favour of real virtual-screen metrics.
- Start the ladder at rung index 2 (1920) rather than 0 unless the peer signals it can take more, so nobody's hotel Wi-Fi opens on a 20 Mbps rung.
- Admin: extend `RungEdges` in `LiveSessionViewModel.cs` to match the new ladder — it must stay in lockstep or the stats pill lies.

### Step 2 — Hardware H.264 path (only after step 1 is verified on a real 4K session)
- New `agent/src/HwH264Encoder.cs`: wraps the winning MFT from `HwEncoderProbe` behind SIPSorcery's video encoder interface (NV12 in, Annex-B out, forced IDR on PLI/FIR).
- `WebRtcSession.BuildPeer`: when `HwEncoderProbe.HardwareH264Available` and the wrapper initialises, advertise H.264 **and** VP8 and accept whichever is negotiated; otherwise keep today's VP8-only restriction untouched.
- `admin/src/Media/WebRtcClient.cs` + `VideoPipeline.cs`: advertise both codecs, add a Media Foundation H.264 decode path alongside the existing libvpx one, select on the negotiated format.
- `src/lib/webrtc-live.ts`: stop excluding H.264 from the browser's offer — browsers decode it in hardware already.
- Keep the codec-pinning guardrail comments in sync across all three peers; they are load-bearing.

### Step 3 — Re-tune the ladder
Only once a real 4K session exists: measure RTCP loss/RTT at 20 Mbps and adjust the step-down thresholds and the 10s/12s climb windows, which were tuned for a 4 Mbps ceiling and will oscillate at 20.

### Documentation
Record all three steps in `PROJECT-MAP.md` as S17 with the same cause/fix format used for S16, and delete the stale `HwEncoderProbe.cs:105` "wire codec remains VP8 this build" claim when step 2 lands.

## Out of scope for this plan
Input/video wire prioritisation (separate item, smaller win) unless you want it folded into step 1.
