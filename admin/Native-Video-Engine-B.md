# Native-Video-Engine-B.md

**Option B — full native build. No WebView, no livestream embed, no shortcuts.**
How a VP8 stream becomes pixels in the WPF admin console, file by file, plus the
three gates that must be green before integration is trusted.

```text
agent (DXGI capture → VP8 encode)
        │  RTP/SRTP over ICE (STUN only, no TURN)
        ▼
admin/src/Media/WebRtcClient.cs        transport + signalling  (Gate A / CL-1)
        │  OnVideoFrameReceived → whole VP8 frames
        ▼
admin/src/Media/VideoPipeline.cs       jitter queue (3, drop-oldest)
        │                              decode on "connectlive-vp8-decode" thread
        │  SIPSorceryMedia.Encoders 8.0.7  (VideoEncoder.DecodeVideo, VP8)
        ▼
admin/src/Media/FrameConvert.cs        I420 / BGR24 / BGRA32 → packed BGRA32
        │                              BT.601 limited range  (Spike 1 locked)
        ▼
admin/src/Media/D3DImageHost.cs        one D3D9Ex device + one reusable surface
admin/src/Media/D3D9Ex.cs              vtable interop: CreateDeviceEx / CreateRenderTarget
        │                              LockRect → pitch-respecting copy → UnlockRect
        ▼  dispatcher-marshalled Lock/SetBackBuffer/AddDirtyRect/Unlock
D3DImage  →  <Image Stretch="Uniform">  in admin/src/Views/LiveSessionWindow.xaml
        │
        ▼
admin/src/Media/ContentRect.cs         aspect-correct render + input mapping
```

Fallback ladder (never a black screen): **D3D present → WriteableBitmap present →
JPEG frame pump** (`FrameFallbackPump.cs`), and the on-screen pill only says
"Native video" while `VideoPipeline.IsPresenting` is true.

---

## The three gates

### CL-1 — peer connection reaches `connected` (transport only)

Owner: `admin/src/Media/WebRtcClient.cs` + `agent/src/WebRtcSession.cs`.
Admin offers (ruling R1). STUN-only. **No decode involved.**

Every milestone is logged with a monotonic stamp:

```text
[t=0]    [webrtc] bind ok — building peer
[t=…]    [webrtc] offer created + local description set
[t=…]    [webrtc] offer posted
[t=…]    [webrtc] local candidate gathered type=host
[t=…]    [webrtc] local candidate gathered type=srflx
[t=…]    [webrtc] answer applied: ...
[t=…]    [webrtc] remote candidate type=host|srflx
[t=…]    [webrtc] iceConnectionState=checking → connected
[t=…]    [webrtc] connectionState=connected
[t=…]    [webrtc] TRANSPORT GREEN — connected
```

Pass: `TRANSPORT GREEN` appears, at least one `srflx` on each side, no ICE
restart within the first 12s (`StartConnectWatchdog`).

Run:

```powershell
dotnet build admin/src/ConnectLiveAdmin.csproj -c Release
# start a session from the console, then:
type "%LOCALAPPDATA%\ConnectLive\admin.log" | findstr /C:"[webrtc]"
```

### Spike 1 — VP8 decodes with correct colour (orange stays orange)

`admin/spikes/vp8-decode/` — offline replay, no network, no UI.

> **RETIRED 2026-08-05.** The `CONNECTLIVE_RTP_CAPTURE` tap (`RtpCapture.cs`)
> that produced the input file was deleted in the §10.11 alignment pass — its
> gate had already passed and the class carried its own "delete after Phase 3"
> instruction. The spike project remains readable as evidence, but it can no
> longer be fed from a live session. To re-run it, re-add a passive tap on the
> `OnRtpPacketReceived` handler in `admin/src/Media/WebRtcClient.cs` first.

Historic capture format: `[int64 arrivalUnixMs][int32 len][len bytes]` at
`%LOCALAPPDATA%\ConnectLive\spikes\vp8-decode\capture.rtpdump`.

The spike depacketizes RFC 7741, decodes, converts with the **shipping**
`FrameConvert.cs` (linked, not copied) and writes 5 PNGs plus an
`ORANGE-CHECK` line per frame.

Pass: keyframe decodes, PNGs coherent (no shear, no R/B swap), hue 15–50°.
A hue below 15° means someone swapped BT.601 limited for BT.709/full range —
revert, don't "tune".

### Spike 2 — bitmap presents via D3DImage

`admin/spikes/d3d-present/` — throwaway WPF window around the **shipping**
`D3DImageHost` / `D3D9Ex`.

```powershell
dotnet run --project admin/spikes/d3d-present
```

Pass: orange/steel card animates on screen; **Force device loss** recovers and
keeps animating; `devices=1` after Park ×3 (G3, no per-session device churn);
`surfaces` only increments on a resolution change.

---

## Integration (only after A + B + C are green)

`WebRtcClient.WireVideo` → `Pipeline.Submit(frame)` → decode thread →
`FrameConvert` → `D3DImageHost.PushBgra` → dispatcher present.
Rules that are not negotiable: decode **off** the UI thread, present **on** it,
drop the **oldest** frame under pressure, keyframe (PLI) **before** ICE restart,
resolution change **resizes in place** — never a teardown.

## Geometry — mouse must feel native

One helper, `ContentRect.cs`, used by `ToAbs()`, the cursor ghost and wheel
position in `LiveSessionWindow.xaml.cs`:

```text
scale  = min(elemW/srcW, elemH/srcH)
drawn  = src * scale
offset = (elem - drawn) / 2
norm   = clamp((point - offset) / drawn, 0, 1)
```

Recomputed on `SizeChanged` and on source-resolution change; clicks on the
letterbox bars are ignored rather than clamped to an edge.

## Measurement (G1/G2)

`VideoPipeline.StatsLine()` is logged every 60s and rendered live in the window:

```text
[video] fps=28.7 queue=1 in=1731 decoded=1728 dropped=3 presented=1728
        latency=41ms size=1920x1080 path=d3d devices=1 surfaces=1 ws=214MB
```

SOAK gate: 10 minutes of sustained motion with one forced mid-session
resolution change; fps within ±10% of source, `devices` flat, working set flat.

## Cleanup

The RTP tap (`RtpCapture.cs`) and both `admin/spikes/*` projects are evidence
harnesses. They ship disabled (env-flag gated, not referenced by
`ConnectLiveAdmin.csproj`) and are deleted after the SOAK gate signs off.
