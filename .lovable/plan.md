## What's happening

The stream is healthy (`WebRTC video` pill, real frame rate) — quality is the problem. Two concrete causes in the agent's capture path:

**1. Alpha blending dims every frame (the "darkened" look).**
In `agent/src/ScreenCapture.cs` the capture buffer is `Format32bppArgb` and both draws use GDI+'s default `SourceOver` compositing:
- `g.DrawImageUnscaled(dxFrame, 0, 0)` — the DXGI Desktop Duplication surface is `B8G8R8A8` and Windows leaves alpha meaningless (often 0) across large regions of composited windows. Blending that over a freshly allocated transparent bitmap pulls those pixels toward black — exactly the muted, hazy window graphics in your screenshot.
- The downscale `g.DrawImage(rawBmp, 0, 0, w, h)` then blends a second time.

The JPEG fallback flattens alpha on save, which is why this reads worse on the WebRTC layer than it used to on frames.

**2. The WebRTC tee only runs on changed frames.**
`live.PushFrame(...)` sits inside the branch that runs only when the frame hash changed and the pipeline isn't idle. A mostly-static desktop starves the VP8 encoder, so the decoder holds a stale picture and window redraws land late or smeared.

## Changes

**`agent/src/ScreenCapture.cs`**
- Allocate `rawBmp` and `scaledBmp` as `PixelFormat.Format32bppRgb` (no alpha channel).
- Set `CompositingMode.SourceCopy` on the DXGI blit and the downscale draw, plus `CompositingQuality.HighQuality`. Source pixels copied verbatim — no alpha math, no darkening.
- Keep `HighQualityBicubic` + `PixelOffsetMode.HighQuality` for the downsample.
- Force alpha opaque on the WebRTC tee buffer: after `Marshal.Copy`, write `0xFF` into every 4th byte before `PushFrame`, so BGRA→I420 can never read a zero alpha.
- Move the tee out of the "changed" branch into a helper called every loop iteration with a valid `scaledBmp` — full rate when the screen changes, throttled to ~1 push/sec when idle so the encoder stays alive without burning CPU.

**`agent/src/DxgiCapture.cs`**
- Confirm the staging-texture copy returns a no-alpha bitmap format; if it returns `Format32bppArgb`, switch to `Format32bppRgb` so the blend can't re-enter through the back door.

## Sharpness (separate, smaller lever)

The Normal profile caps the long edge at 1920px, so a 4K desktop is downsampled before VP8 ever sees it. I'd leave that cap alone this pass — removing the alpha blend is what restores contrast and window detail. If it still reads soft afterwards, the next step is a WebRTC-only tee at native resolution while the JPEG fallback stays at 1920px.

## Not touched

Signal kinds and payloads, `admin_client_id` routing, curtain heartbeat, `bind_admin` cadence, input coalescers, transport taxonomy, admin/web console rendering, and all endpoints. Agent-side capture only.

## Deliverable

Repack the agent source as `ConnectLive-RemoteAgent-src-v1.5-<date>.zip` under `/mnt/documents/` and `public/`. The admin console is unchanged, so its zip stays at v1.3.
