# Fix admin build: `VideoEncoder` type doesn't exist in SIPSorceryMedia.Encoders 8.0.7

## Root cause (verified, not guessed)

I pulled `SIPSorceryMedia.Encoders` 8.0.7 from nuget.org and dumped the exported
types. The package exposes **`VpxVideoEncoder`** and **`Vp8Codec`** — there is
no `VideoEncoder` type. `admin/src/Media/VideoPipeline.cs` declares
`private VideoEncoder? _decoder;` (line 44) and `new VideoEncoder()` (line 188),
so CS0246 is correct: the name simply isn't in that assembly at this version.

The Vp8 spike (`admin/spikes/vp8-decode`) compiled fine only because it links
`FrameConvert.cs` and never touches the decoder type.

The `NU1903` line about `SIPSorcery 6.2.4` is a warning, not the failure — it
did not stop the build. We can address it separately.

## Fix

One file, two edits, no behaviour change:

- `admin/src/Media/VideoPipeline.cs`
  - line 44: `private VpxVideoEncoder? _decoder;`
  - line 188: `_decoder = new VpxVideoEncoder();`

`VpxVideoEncoder.DecodeVideo(byte[], VideoPixelFormatsEnum, VideoCodecsEnum)`
has the same signature the pipeline already calls, so `DecodeOne` and
`Dispose` need no changes.

## Verify

Local sandbox can't run `dotnet publish` for a WPF Windows target, so
verification is on your Windows box:

```
powershell -ExecutionPolicy Bypass -File build.ps1
```

Expected: `Restored ... Build succeeded ...` and `dist\ConnectLiveAdmin.exe` /
`.zip` produced. The `NU1903` SIPSorcery warning will still print — it's
non-fatal and separate from this fix.

## Re-cut the source zip

After the edit lands I regenerate `ConnectLive-Admin-source-<date>.zip` so
you don't have to hand-patch the file on the Windows box.

## Not doing in this plan

- Bumping SIPSorcery past 6.2.4 to clear NU1903 — that's an API-surface change
  (breaks `RTCPeerConnection` calls in `WebRtcClient.cs`) and deserves its own
  plan. Say the word and I'll scope it as a follow-up.
- Touching `agent/` — the agent uses `Vortice` for capture, not the encoders
  package, and its own build is unaffected.
