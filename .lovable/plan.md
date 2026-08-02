## Objective

Make the native WPF admin console render live video directly (decoded VP8 → D3D), with stable mouse/keyboard control and a curtain that never drops — no more JPEG-fallback lag or "stalled" sessions. Delivered in the agreed gate order, one change at a time, each with operator-runnable evidence (no .NET SDK here).

## Sequence

### Gate A — transport reaches `connected`
`admin/src/Media/WebRtcClient.cs` + `agent/src/WebRtcSession.cs`
- Log every ICE state transition, candidate type (host/srflx), and offer→answer→ICE timeline with elapsed ms on both ends.
- Assert trickle: candidates post the instant they're gathered, on the signal fast path.
- Admin offers (R1). STUN-only. No decode.
- Evidence: timeline log ending `connectionState=connected`.

### Gate B — Spike 1: VP8 decode + color
- Debug-flag-gated RTP tap in `OnRtpPacketReceived` writing length-prefixed packets + timestamps to `admin/spikes/vp8-decode/capture.rtpdump` (JPEG stays on screen, undisturbed).
- Offline replay spike: depacketize → decode (`SIPSorceryMedia.Encoders 8.0.7`, candidate #1) → I420→BGRA → 5 PNGs.
- Gate: orange stays orange, image coherent. Decoder decision written into the spike README and locked.

### Gate C — Spike 2: D3DImage present
- Throwaway WPF spike: D3D9Ex device + one reusable surface, static bitmap through `D3DImageHost`; force device-lost/reset and confirm recovery.
- Gate: bitmap on screen, survives reset, no crash.

**GO/NO-GO: A + B + C green before any integration.**

### Phases 1–2 — real pipeline
Depacketizer + ~3-frame jitter buffer (loss → PLI); decode off the UI thread; bounded drop-oldest queue; I420→BGRA ported verbatim from Spike 1; `D3DImageHost` owns the device and one reusable surface; dispatcher-marshalled present; device-lost recreates and continues.

### Phase 3 — live video + measurement
On-screen/logged fps counter, decode-to-present latency estimate, orange card verified through the live pipeline. Gate: sustained fps at source rate ±10%.

### Phase 4 — robustness & persistence
- Decode stall / loss → keyframe request first, then admin-initiated ICE restart.
- Mid-session resolution change resizes the texture, no teardown.
- G5-F1: `NetworkChange` handler for instant reconnect on connectivity return.
- Curtain persistence: verify the 1s `curtain_on` heartbeat survives reconnects and pauses.

### Phase 5 — geometry (mouse feels native)
One content-rect helper in `LiveSessionWindow.xaml.cs`:
```text
scale  = min(elemW/srcW, elemH/srcH)
drawn  = src * scale
offset = (elem - drawn) / 2
norm   = clamp((point - offset) / drawn, 0, 1)
```
Used by `ToAbs()`, `UpdateCursorGhost()`, and wheel position; recomputed on `SizeChanged` and on source-resolution change. Transport-agnostic. Tested at 4 corners + 4 edge midpoints.

### Phase 6 — honesty, teardown, SOAK
- Pill says "Native video" only when decoded frames are presenting; JPEG labelled as fallback.
- Teardown ×3: peer closes, decoder/queues flush, D3D surface parks (no per-session device churn), admin returns to device list with dot live.
- 10-minute sustained-motion SOAK with a forced mid-session resolution change; per-minute stats logger (fps, queue depth, working set).

## Technical notes

- No .NET SDK in this environment: every gate ships with exact operator commands and the evidence to capture.
- Guardrails held: two planes never cross, no backend key on the agent, decode off the UI thread, present on it, color proven before D3D, native DLLs verified win-x64 in `admin/build.ps1`.
- Deferred (unchanged): `/api/public/ice` gateway, input over datachannel, TURN — all re-enter post-SOAK.
- Zips repackaged at each green gate so you can run the evidence capture.

## First deliverable

Gate A instrumentation in `WebRtcClient.cs` and `WebRtcSession.cs`, plus the operator command list, then Report 2 with the timeline log.