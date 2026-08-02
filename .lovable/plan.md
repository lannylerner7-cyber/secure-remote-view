## Gate Plan v2 — accepted as binding

Rulings absorbed: **R1** admin-offers (and admin initiates ICE restart), **R2** decoder decided inside Spike 1, **R3** ICE gateway + input datachannel go to the Deferred Register with re-entry conditions, **R4** D3D9Ex + D3DImage only, no hedge. All seven restorations (G1–G7) are in the sequence below.

## Report 1 — CL-0+ (next deliverable, before any gate code)

Read-only audit, three parts, delivered as one report:

- **CL-0 baseline:** confirm enrollment → device token → device row → online dot, end to end.
- **G4 — session state machine:** read the session code and report, state by state, which of `invited → consented → active → paused → ended` actually exist, and whether the agent's join order (carried `session_id` → `last_session_id` from store → await fresh invite) is present. Missing pieces are **named** in this report; they land with CL-4, but CL-1 is not green until they're named.
- **G5 — presence resilience:** verify reconnect-with-backoff on drop **and** a `NetworkChange` handler that snaps an immediate reconnect when connectivity returns. Either missing = a small named fix inside CL-0, not a silent pass.

## Gate A — CL-1, transport reaches `connected` (Report 2)

Instrument both ends: every ICE state transition, candidate type (host/srflx), offer→answer→ICE timeline with elapsed ms, and proof that candidates post the instant they're gathered (trickle) on the signal fast path — never batched behind bulk data. Admin-offers per R1. Enrolled-before-signalling guardrail asserted even without the ICE gateway. **Evidence:** the timeline log ending in `connectionState=connected`. No decode involved.

## Gate B — Spike 1, decode + color (Report 3)

- **Step 0 (G6) — RTP capture harness:** a debug-flag-gated passive tap in `WebRtcClient.OnRtpPacketReceived` writing length-prefixed packets + arrival timestamps to `admin/spikes/vp8-decode/capture.rtpdump`. Operator records one burst on a live session (JPEG stays on screen; the tap doesn't disturb it). Tap is deleted after Phase 3.
- Spike replays from disk, fully offline: depacketize → decode → I420→BGRA → dump 5 PNGs.
- **R2 trial:** `SIPSorceryMedia.Encoders 8.0.7` is candidate #1. If its decode path is missing/wrong or fights beyond one focused session → libvpx P/Invoke; FFmpeg only if libvpx binding itself fights. Decision written into the spike's README and **locked**.
- **Gate:** orange stays orange, image coherent.

## Gate C — Spike 2, D3DImage present (Report 4)

Throwaway WPF spike: D3D9Ex device + one reusable surface, static test bitmap through `D3DImageHost` onto a window; force a device-lost/reset and confirm recovery. Zero decode. **Gate:** bitmap on screen, survives reset, no crash.

**GO/NO-GO:** A + B + C all green. Never integrate on red.

## Phases 1–2 — real pipeline

Depacketizer + ~3-frame jitter buffer with loss → PLI; decode off the UI thread; bounded drop-oldest queue; production I420→BGRA ported **verbatim** from Spike 1; `D3DImageHost` owns the device and one reusable surface; dispatcher-marshalled present; device-lost recreates and continues.

## Phase 3 — live video + G2 measurement (Report 5)

Not eyeballed: fps counter (on-screen or logged), decode-to-present latency estimate, and the orange test card verified **through the live pipeline**, not just spike PNGs. **Gate:** sustained fps at source rate ±10%, orange stays orange live.

## Phase 4 — robustness

Decode stall / packet loss → keyframe request first, then **admin-initiated** ICE restart (R1). Mid-session source-resolution change resizes the texture and re-fits — no teardown.

## Phase 5 — geometry (Report 6)

One content-rect helper:
```text
scale  = min(elemW/srcW, elemH/srcH)
drawn  = src * scale
offset = (elem - drawn) / 2
norm   = clamp((point - offset) / drawn, 0, 1)
```
Used by `ToAbs()`, `UpdateCursorGhost()`, and wheel position; recomputed on `SizeChanged` **and** on source-resolution change. Built **transport-agnostic** so the future datachannel swap touches transport only, not math. Tested at 4 corners + 4 edge midpoints.

## Phase 6 — honesty, teardown, SOAK (Report 7)

- **Pill honesty:** "Native video" only when decoded frames are presenting; JPEG labelled as the fallback it is.
- **G3 teardown ×3:** peer closes cleanly, decoder + queues flush, D3D surface **parks** (no per-session device churn), agent returns to presence-only, admin returns to the device list with the dot still live. connect → end → reconnect ×3, no leak, no zombie state.
- **G1 SOAK — the final gate:** 10-minute sustained-motion session on the native path with a forced mid-session resolution change. Verify no crash, no tear, no memory growth (working set flat after warmup), no color drift. Ships with a soak checklist **and** a per-minute stats logger (fps, queue depth, working set) so the operator's run produces the evidence. Nothing is done before this is green.

## Deferred Register (carried forward verbatim)

| Item | Clause | Status | Re-enters when |
|---|---|---|---|
| `/api/public/ice` gateway | C3 | Deferred (R3) | Post-SOAK; lands with TURN scoping as its own contract |
| Input over WebRTC datachannel | C5 / CL-5 | Deferred (R3) | Post-SOAK; Phase 5 helper is transport-agnostic so the swap is transport-only |
| TURN | C3 note | Out of scope | Own contract, with the ICE gateway |
| Agent encode/RTP timing | 4.2 | **N/A — declared (G7)** | Only if agent capture is ever touched |

Any new deferral is added here with a re-entry condition, never dropped silently.

## Operating constraints

- No .NET SDK in this environment: **every gate ships with the exact operator commands and the evidence to capture** (logs / PNGs / screenshots / stats). A gate without runnable evidence instructions is not a delivered gate.
- Seven reports, one change at a time, no bundling. Guardrails held: two planes never cross, no Supabase key on the agent, decode off the UI thread, present on it, color proven before D3D, native DLLs verified win-x64 in `admin/build.ps1`, signalling instant and trickled.
- Honest caveats on the record: Spike 1 (does SIPSorcery decode) and restrictive NATs (STUN-only until TURN lands) are the two places reality can still bite. Everything else is deterministic once A, B, C are green.

**Next action on approval: produce Report 1 (CL-0+ with G4 and G5 findings). No gate code before it.**
