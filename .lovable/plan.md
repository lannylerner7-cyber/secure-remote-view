# Fix the Admin build without repackaging

The zip you downloaded still contains the pre-fix `VideoPipeline.cs`. The repo copy is already correct, so instead of re-cutting a zip you only need to change **two lines** in the file on your machine.

File: `C:\Users\HomePC\Downloads\ConnectLive-Admin-source-2026-08-03\src\Media\VideoPipeline.cs`

## Line 44

Replace:

```text
    private VideoEncoder? _decoder;
```

with:

```text
    private VpxVideoEncoder? _decoder;
```

## Line ~188 (inside `DecodeLoop()`, the `try { _decoder = new ... }`)

Replace:

```text
        try { _decoder = new VideoEncoder(); }
```

with:

```text
        try { _decoder = new VpxVideoEncoder(); }
```

Nothing else changes: the `using SIPSorceryMedia.Encoders;` at line 9 is already present, and the `_decoder!.DecodeVideo(encoded, VideoPixelFormatsEnum.Bgra, VideoCodecsEnum.VP8)` call has the same signature on `VpxVideoEncoder`.

## Why

`SIPSorceryMedia.Encoders` 8.0.7 renamed the software codec class from `VideoEncoder` to `VpxVideoEncoder`. That single missing type aborts the publish, which is why `publish\admin\ConnectLiveAdmin.exe` never got produced and `Copy-Item` then failed — the copy error is a symptom, not a second bug.

## After the edit

```text
powershell -ExecutionPolicy Bypass -File build.ps1
```

`warning NU1903` (SIPSorcery 6.2.4 advisory) will still print. It is a warning, not an error, and does not block the build. Say the word if you want the SIPSorcery upgrade scoped as its own change — it touches the WebRTC client and needs its own verification pass.
