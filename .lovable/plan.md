# Fix the three real compile errors in the Agent and Admin source zips

All three are genuine type errors that only a Windows `dotnet publish` surfaces.
Everything else in your two logs is a **warning**, not a failure.

## 1. Agent — `WebRtcSession.cs(127,33)`: `'App' does not contain a definition for 'Api'`

`App.xaml.cs` never exposes a static `Api`; it creates a local
`var api = new ApiClient(apiUrl)` and hands it down through constructors.
`WebRtcSession` already receives one and stores it as `_api` (line 41, set in
the constructor at line 84).

**Fix:** line 127 becomes `await _api.GetIceConfigAsync(_cts.Token)`.
No new plumbing — the instance is already there.

## 2. Agent — `StreamListener.cs(123,33)`: cannot convert `char` to `string`

The line is `line.StartsWith(':', StringComparison.Ordinal)`. `StartsWith` has
a `(char)` overload and a `(string, StringComparison)` overload, but no
`(char, StringComparison)`, so the compiler binds to the string overload and
rejects the char literal.

**Fix:** `line.StartsWith(":", StringComparison.Ordinal)`.

## 3. Admin — `VideoPipeline.cs(44,13)`: `VideoEncoder` not found

I pulled `SIPSorceryMedia.Encoders` 8.0.7 from nuget.org and dumped its
exported types: it ships **`VpxVideoEncoder`** and **`Vp8Codec`**. There is no
`VideoEncoder` type at this version.

**Fix:** in `admin/src/Media/VideoPipeline.cs`
- line 44: `private VpxVideoEncoder? _decoder;`
- line 188: `_decoder = new VpxVideoEncoder();`

`VpxVideoEncoder.DecodeVideo(byte[], VideoPixelFormatsEnum, VideoCodecsEnum)`
matches the call already in `DecodeOne`, so no other change is needed.

## Warnings I am deliberately leaving alone

- **NU1903, SIPSorcery 6.2.4 high-severity advisory** (both projects). Real,
  but bumping the major breaks the `RTCPeerConnection` surface in
  `WebRtcSession.cs` and `WebRtcClient.cs`. Non-blocking. I'll scope it as its
  own plan if you want it cleared.
- **WFAC010** — WinForms DPI configured via manifest instead of project
  property. The manifest values are intentional for the curtain-overlay
  coordinate maths; changing them is risky.
- **CS1998** in `Agent.cs` 275/293 — async methods with no await. Cosmetic.

## Verification

Sandbox is Linux and cannot compile WPF/win-x64, so verification is your box:

```
cd ConnectLive-Agent-source-<date>  ; powershell -ExecutionPolicy Bypass -File build.ps1
cd ConnectLive-Admin-source-<date>  ; powershell -ExecutionPolicy Bypass -File build.ps1
```

Expected: both restore, publish, and produce `dist\ConnectLive.exe` (+
installers) and `dist\ConnectLiveAdmin.exe`. NU1903 will still print.

## Re-cut zips

After the three edits I regenerate both source zips under `/mnt/documents/` so
you don't hand-patch on the Windows box.
