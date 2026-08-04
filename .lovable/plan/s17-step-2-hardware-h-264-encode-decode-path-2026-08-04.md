# S17 Step 2 — Hardware H.264 encode/decode path

## Current state (verified)

- S17 Step 1 is shipped. `agent/src/BitrateController.cs` has eight rungs (3840/2560/1920/1600/1280/1024/800/640), `DefaultRung = 2`, and a `Ceiling` guard.
- `agent/src/WebRtcSession.cs:176` sets `BitrateController.Ceiling = DefaultRung` for the life of a VP8 peer, and `:184` restricts the encoder to `VideoCodecsEnum.VP8`. Any non-VP8 negotiated codec is rejected at `:219-222`.
- `admin/src/Media/VideoPipeline.cs` is VP8-only: it constructs `VpxVideoEncoder` at `:148` and decodes with `VideoCodecsEnum.VP8` at `:276`.
- `admin/src/Media/WebRtcClient.cs:164-168` pins the offer to a single VP8 format.
- `src/lib/webrtc-live.ts` does not restrict codecs, so the browser will accept H.264 once the agent and admin advertise it.
- `agent/src/HwEncoderProbe.cs` discovers NVENC/QuickSync/AMF and reports availability, but nothing consumes it. The class comments explicitly state it does not wrap the MFT or change the wire codec.
- `PROJECT-MAP.md` §10.5 documents Step 1 and leaves Steps 2-3 open; §10.6 concludes that encode/decode is the only remaining gap versus ScreenConnect/Parsec and recommends measuring Step 1 before building Step 2.

## Why Step 2 is hard (not a vague roadmap problem)

The roadmap is clear; the work is just large. Three things make it expensive:

1. **The MFT wrapper is the bulk of the work, not the negotiation.** `HwEncoderProbe` only enumerates encoders. A usable path needs a new `agent/src/HwH264Encoder.cs` that implements SIPSorcery's `IVideoEncoder` around an asynchronous Media Foundation Transform: NV12 in, Annex-B H.264 out, async MFT event pumping, `MFT_MESSAGE_COMMAND_FLUSH`, dynamic type negotiation, and forced IDR on PLI/FIR. That is several hundred lines of COM interop.
2. **All three peers must change together.** Agent must advertise H.264 + VP8 and encode H.264. Admin must advertise H.264 + VP8 and decode H.264 via Media Foundation. The web console needs no codec restriction change. If any peer still pins VP8, the session falls back to software VP8. A partial change can negotiate a stream that nothing can encode.
3. **The regression surface is black-screen, not graceful.** A broken MFT wrapper does not cleanly fall back to VP8; it can leave the admin with a connected peer that produces no decodable video and no obvious diagnostic.

## What the change will feel like if it lands correctly

- **Sharpness:** 1:1 pixel passthrough at 3840x2160 with a hardware H.264 encoder at ~20 Mbps makes small UI text readable without zooming. This is the single largest visible difference.
- **Latency:** hardware encode removes the agent's dominant CPU cost, so frame pacing stops collapsing under load. Expect steadier 30 fps on busy machines.
- **Agent load:** NVENC/QSV/AMF encode is near-free; the CPU graph on the endpoint drops sharply. Machines without hardware encoder stay on software VP8 at the current ceiling.
- **Bandwidth:** 20 Mbps is a LAN/fibre number. The ladder still steps down on congestion, so bad links behave exactly as today.
- **Admin stability:** decoding H.264 through Media Foundation removes libvpx from the native admin entirely, retiring the "decoder unavailable" failure mode.

## Approved sequence (1-3), with the roadmap updated at each step

Each step below ends with a `PROJECT-MAP.md` update, so the map always says where we are and what is left.

### Step 1 — Make the measurement possible, then measure (build now)

The evidence S17 needs does not exist yet: nothing in the agent reports encode time or CPU. Step 1 ships the instruments, then you run one real 4K session.

Code:
- New `agent/src/EncodeStats.cs` — per-session encode timing (JPEG path and software VP8 path, separately), agent process CPU as a percentage of one core, working set, and the peak/last frame geometry actually handed to an encoder. Lock-free on the hot path; a failed CPU read reports "not measured" rather than throwing.
- `agent/src/ScreenCapture.cs` — time the JPEG encode alone (not the upload, which the ladder already owns) and feed `EncodeStats`.
- `agent/src/WebRtcSession.cs` — time the VP8 encode submission in `PushFrame` and feed `EncodeStats`; reset stats when a peer is built.
- `agent/src/ApiClient.cs` — add an `encode` block to the heartbeat payload (`jpeg_ms`, `vp8_ms`, `cpu_pct`, `ws_mb`, `peak_width`, `peak_height`, `rung`), so the fleet-wide answer lands in `devices.metadata` with no new table.
- Agent log gains one `[encode]` line per stats window, to be read alongside the admin's existing per-minute `[video]` line.

Evidence to collect from one real 4K session:
- `session_telemetry` shows `source_width`/`source_height` at the monitor's native size (proves 1:1 passthrough and unclamped bounds are live).
- Sustained `fps` and `latency_ms` at rung 2 (1920px) and, on the JPEG path, at rungs 1 and 0 (2560px/3840px).
- `render_path = d3d`, `frames_dropped` flat, no `NativeVideoUnavailable` in the session log.
- Agent `cpu_pct` and `vp8_ms` while encoding, alongside the `HwEncoderProbe` result already in the heartbeat.

Roadmap: new `PROJECT-MAP.md` §10.7 recording the instruments and the pass/fail criteria above.

### Step 2 — Decide from the data

- If `vp8_ms` exceeds the frame budget or `cpu_pct` pins at 2560px/3840px, Phase A-D below go ahead as written.
- If the JPEG path holds 3840px acceptably, Step 3 (ladder re-tune) ships first and the MFT wrapper stays queued.

Roadmap: §10.7 gains the measured numbers and the decision, written down so it is not re-litigated from memory.

### Step 3 — Build hardware H.264 behind a kill switch (only if Step 2 says so)

The kill switch ships in Step 1 so it is already in the field before the encoder it governs:
- New `agent/src/CodecPolicy.cs` — reads `CONNECTLIVE_CODEC` (`vp8` | `auto` | `h264`), defaults to `vp8`. `AllowH264` additionally requires real silicon from `HwEncoderProbe`, because the software fallback MFT is slower than libvpx. Nothing consumes it in Step 1; `WebRtcSession` still pins VP8 unconditionally. When the encoder lands, the pin reads this class, so a bad MFT in the field is one environment variable away from being switched off.

Then Phases A-D:

## Implementation (Phases A-D, gated on Step 2)


### Phase A — Agent-side hardware encoder
- New `agent/src/HwH264Encoder.cs`:
  - Wrap the MFT selected by `HwEncoderProbe` behind `IVideoEncoder`.
  - Accept NV12 frames, produce Annex-B H.264 NAL units.
  - Handle async MFT process/drain events.
  - Force IDR on PLI/FIR with a cooldown similar to `RequestKeyFrame`.
  - Fail gracefully: if the MFT throws during a session, mark the encoder dead and fall back to VP8 for that peer.
- `agent/src/WebRtcSession.cs`:
  - When `HwEncoderProbe.HardwareH264Available` and the wrapper initialises, advertise both H.264 and VP8.
  - Accept whichever codec is negotiated.
  - If H.264 wins, route raw samples through `HwH264Encoder`; keep VP8 path unchanged.
  - Lift `BitrateController.Ceiling` to `0` when H.264 is active; keep `DefaultRung` for VP8 peers.
- `agent/src/ScreenCapture.cs`:
  - Feed NV12 to the H.264 encoder instead of BGRA when H.264 is active. Reuse the existing 1:1 passthrough path.

### Phase B — Admin-side H.264 decode
- `admin/src/Media/VideoPipeline.cs`:
  - Add a Media Foundation H.264 decoder path alongside `VpxVideoEncoder`.
  - Select decoder on the negotiated SDP format.
  - Convert decoder output (NV12/YV12) to BGRA32 via `FrameConvert`.
- `admin/src/Media/WebRtcClient.cs`:
  - Advertise both VP8 and H.264 in the offer.
  - Select decoder based on the negotiated codec.

### Phase C — Web console
- `src/lib/webrtc-live.ts`:
  - Ensure H.264 is not excluded from the offer. No other change is required; browsers decode H.264 in hardware already.

### Phase D — Guardrails and documentation
- Add a runtime flag (environment variable or build constant) that forces VP8-only, so Step 2 can be disabled in the field without a code rollback.
- Update `PROJECT-MAP.md` §10.5: mark Step 2 closed, remove the stale `HwEncoderProbe.cs:105` "wire codec remains VP8 this build" claim, and document the kill switch.
- Update `agent/build.ps1` and `admin/build.ps1` to emit the new encoder-capability telemetry in the build log.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Negotiated H.264 but encoder wrapper fails at runtime | Fail the wrapper init before changing the SDP codec list; keep VP8-only if init fails. |
| Admin decodes H.264 but D3D present path chokes on new format | Keep WriteableBitmap fallback; add format-specific diagnostics. |
| Field machine has a hardware MFT that advertises H.264 but cannot sustain 4K | Cap the ladder at 2560px for unknown-vendor MFTs; only NVENC/QSV/AMF get the 3840 rung. |
| Regression in existing VP8 path | Build H.264 as additive; do not remove or refactor the VP8 path. The kill switch forces VP8-only. |
| No field measurement to justify the work | Make Phase A contingent on Step 1 telemetry from a real 4K session. |

## Out of scope

- Input/video wire prioritisation (smaller win, separate item).
- HEVC or AV1 codecs.
- Content-aware rung selection.
- Server-side frame relay for slow admins.

## Decision needed

Approve this plan to start with the measurement phase and then proceed to Phase A only if the data justifies it. Reject or skip if you want to stay on Step 1 and Step 3 only.
