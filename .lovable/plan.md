# Brain Engine Upgrade — RDP-class streaming behaviour

Goal: bring the ConnectLive video engine closer to how Remote Desktop feels — crisp text, no stutter on motion, instant redraw of repeated UI, and graceful degradation on bad links.

## Where we actually are today (verified in code)

- The WebRTC wire codec is hard-pinned to software VP8 (`agent/src/WebRtcSession.cs`: `RestrictFormats(... VP8)`, and any other negotiated codec is rejected).
- Because VP8 is software, the resolution ladder is capped: `BitrateController.Ceiling = DefaultRung` (1920px) for the life of every peer, even though rungs for 2560px and 3840px exist.
- `agent/src/CodecPolicy.cs` (kill switch) and `agent/src/HwEncoderProbe.cs` (NVENC/QuickSync/AMF detection) already exist but nothing consumes them.
- The JPEG fallback path has a two-quality scheme (motion vs idle) but one quality per whole frame — no text/image separation.
- DXGI dirty-rect metadata is read only as a boolean "did anything change" (`DxgiCapture.cs:322`, `TotalMetadataBufferSize > 0`). Per-region rectangles are never extracted, so no partial-frame or cached-tile work is possible yet.
- Network sensing already exists and is decent: RTCP receiver reports + upload latency drive an 8-rung ladder with fast step-down and slow climb.
- Transport is already UDP: WebRTC media runs over SRTP/UDP with TCP-like reliability only on the data channels (input, clipboard, files). The RDP "URCP" item is effectively already satisfied by the architecture.

## What to build, in order

### Phase 1 — Hardware H.264 on the wire (biggest single win)
This is the gate for everything else: sharpness, 4K, and CPU headroom all depend on it.
- New `agent/src/HwH264Encoder.cs`: a Media Foundation Transform wrapper implementing SIPSorcery's video encoder interface — NV12 in, Annex-B H.264 out, async event pumping, forced IDR on PLI/FIR, and a hard "mark dead, fall back to VP8" path on any MFT error.
- `WebRtcSession.cs`: advertise H.264 + VP8 when `CodecPolicy.AllowH264` and the wrapper initialises; accept whichever wins; lift the ladder ceiling to 0 (full 4K) only when H.264 is active.
- `admin/src/Media/VideoPipeline.cs` + `WebRtcClient.cs`: advertise both codecs, add a Media Foundation H.264 decode path alongside VP8, convert NV12 output through the existing `FrameConvert`.
- `src/lib/webrtc-live.ts`: stop nothing — browsers decode H.264 in hardware already; just confirm it is not filtered out.
- Kill switch stays: `CONNECTLIVE_CODEC=vp8` forces the old path in the field.

### Phase 2 — Dirty-region streaming (the "progressive display" foundation)
- Extract real dirty and move rectangles from DXGI instead of the current boolean, and expose them from `DxgiCapture`.
- JPEG path: encode only changed regions as tile updates instead of whole frames; the admin composites them into its existing surface.
- H.264 path: feed the encoder a region-of-interest hint so bitrate concentrates where the screen actually changed.

### Phase 3 — Text/image separation
- Classify each dirty tile as text-like or photo/motion-like using an edge-density heuristic computed during capture.
- Text tiles: high quality, low temporal rate (they rarely change, and blur is what makes remote sessions feel bad).
- Motion tiles: lower quality, full frame rate.
- On the H.264 path this becomes a per-region quantisation offset rather than two separate encodes.

### Phase 4 — Client-side tile cache (RDP bitmap caching)
- Hash each encoded tile; keep an LRU of recent tiles on both the native admin and the web console.
- The agent sends a cache-hit reference instead of pixels when a tile it already sent reappears (Start menu, taskbar, window chrome, alt-tab).
- Cache is per-session and memory-bounded; a miss simply sends pixels, so a stale or cold cache can never corrupt the picture.

### Phase 5 — Auto-tuning beyond bitrate
Extend the existing ladder from "resolution and quality" into "visual features", the way RDP drops wallpaper and animations:
- Rungs 5-7 (poor links) additionally request the agent disable font smoothing hints, skip cursor shape updates beyond a low rate, and freeze idle-region refresh.
- Input and cursor always keep priority over video on the wire, so the pointer stays live even when the picture is degrading.

### Phase 6 — Progressive refinement
- On a rung drop, send a fast low-quality pass of the changed area immediately, then a refinement pass for the same region once the link allows.
- Applies to the JPEG path first (simple two-pass quality) and to H.264 via a lower-QP follow-up frame on a static region.

## Notes on risk

- Every phase is additive: VP8 whole-frame streaming stays intact as the fallback, and each new path fails back to it rather than to a black screen.
- Phases 2-6 are cheap once Phase 1 exists; without hardware encode they mostly fight for CPU that VP8 has already taken.
- `PROJECT-MAP.md` gets a new section updated at the end of each phase, so the roadmap always states where the engine is.

## Scope check

Phase 1 alone is a large body of COM interop work across the agent and the native admin. Recommended: approve the whole direction, but build and verify Phase 1 on real hardware before starting Phase 2.
