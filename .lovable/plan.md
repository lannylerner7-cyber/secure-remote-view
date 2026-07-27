
# Smooth Live View — Agent & Admin Performance Upgrade

## Problem

`ScreenCapture.cs` runs at ~7 FPS (140ms delay + GDI copy + JPEG encode). Fast-moving content (CSS animations, video) looks choppy in the admin panel.

## Changes

### 1. Agent — `ScreenCapture.cs`: Triple the frame rate

- **Drop `Task.Delay` from 140ms → 33ms** (target ~30 FPS).
- **Lower default resolution from 1280 → 960px** long edge — cuts pixel count ~44%, proportionally faster GDI copy + JPEG encode.
- **Drop JPEG quality from 55 → 40** during motion (hash changed), bump back to 55 on idle keyframes. Visually imperceptible on video; saves ~30% bandwidth per frame.
- **Adaptive idle backoff**: if 3+ consecutive unchanged frames, increase delay to 100ms to save CPU when the screen is static. Reset to 33ms on any change.

### 2. Agent — `ScreenCapture.cs`: Eliminate redundant Bitmap allocation

Currently allocates `raw` (full-res) + `scaled` every frame. Reuse a pair of pre-allocated bitmaps across the loop (only reallocate if screen bounds change). Cuts GC pressure ~50%.

### 3. Agent — `WebRtcSession.cs`: Match higher cadence

`PushFrame` duration hint is hardcoded to `33` (30 FPS RTP timestamp). This already matches the new target — no change needed, but verify the VP8 encoder doesn't throttle.

### 4. Admin panel — `console.tsx` live view

- **Add an FPS counter overlay** (small badge, top-right of the video frame) so you can see actual throughput.
- **Add a "Quality" toggle** (Normal / Performance) that sends a preference flag to the session. Agent reads it on next heartbeat and switches between 960px/q40 (Performance) and 1280px/q55 (Normal).

### 5. Agent — New `DxgiCapture.cs` (Phase 2 stub)

Create a DXGI Desktop Duplication wrapper behind a feature flag (`--use-dxgi`). When enabled, replaces GDI `CopyFromScreen` with `IDXGIOutputDuplication.AcquireNextFrame`. This is the path to 60 FPS with < 1ms capture latency. The stub will:
- P/Invoke `CreateDXGIFactory1`, enumerate outputs, acquire the duplication interface.
- Fall back to GDI if DXGI init fails (RDP sessions, older GPUs, Session 0).
- Log capture timing so you can compare GDI vs DXGI on your hardware.

Full DXGI + hardware H.264 encoding is a follow-up milestone.

### 6. Repackage agent ZIP

Output updated `ConnectLiveAgent.zip` with all changes.

## Files touched

| File | Action |
|------|--------|
| `agent/src/ScreenCapture.cs` | Rewrite loop timing, resolution, quality, bitmap reuse |
| `agent/src/DxgiCapture.cs` | New — DXGI stub with GDI fallback |
| `agent/src/WebRtcSession.cs` | Verify VP8 duration hint (likely no change) |
| `src/routes/_authenticated/console.tsx` | FPS counter + quality toggle in live view |

## What this does NOT change

- Cursor pump (already 30 Hz, working well)
- WebRTC signaling flow
- HTTPS frame upload endpoint
- Input relay / trackpad / OSK
- Any database schema
