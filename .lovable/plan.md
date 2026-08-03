# Re-cut the Admin Console source zip

Package a fresh sanitized zip of the native Admin console so your local copy matches the repository exactly — no more stale-file mismatches like the `VideoEncoder` / `SendVideoRtcpFeedback` errors, which were already fixed in the repo while your machine still had the old lines.

## What the zip will contain

Everything under `admin/` needed to build on Windows:

- `src/` — including this round's fixes: `Media/ContentRect.cs` (upscale clamp), `Media/WebRtcClient.cs` (`SendRtcpFeedback`), `Media/VideoPipeline.cs` (`VpxVideoEncoder`), `Views/LiveSessionWindow.xaml` + `.xaml.cs` (printable-key handling, `_awaitingText` fallback, `Deactivated` clear, HighQuality scaling), `ViewModels/LiveSessionViewModel.cs` (rung readout, JPEG-size clearing)
- the project/solution files, `build.ps1`, and any packaging assets
- `BUILD-ON-WINDOWS.txt` with the current build and prerequisite steps

## What is excluded

Build artifacts and local state: `bin/`, `obj/`, `.vs/`, `*.user`, `publish/`, NuGet caches, and any local secrets or `.env`-style files.

## Steps

1. Verify the working tree has the fixes in place (already confirmed this session).
2. Build the zip from a clean file list with the exclusions above.
3. Write `BUILD-ON-WINDOWS.txt` into the archive root.
4. Deliver it as a downloadable artifact, dated for today.

No source code changes — this is a packaging step only. Agent-side files are untouched; say the word if you want the Agent zip re-cut alongside it.
