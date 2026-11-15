# Agent 1.10.14 source handoff: curtain display repair

## Status and scope

Prepared in the workspace on 2026-11-15. This file is packaged in the source
ZIP as `VERIFICATION-STATUS.md`. It describes the state **when the ZIP was
created**: at that time the source was not yet pushed to GitHub. The GitHub
delivery made afterwards is recorded separately in
`docs/github-agent-1.10.14-release.md`.

- Agent source version: **1.10.14** (previous handoff: 1.10.13).
- **Not built or run on Windows.** No Agent executable, installer, MSI or
  signed release was produced here. Portable C# checks use inert platform
  adapters and are not Windows evidence.
- The ZIP is the complete Agent source tree with the shared files it needs,
  not only the changed files.
- Native Admin, checkout, pricing, payments, credentials and database schema
  are unchanged. The SQL files in the ZIP are historical reference material;
  do not reapply them for this update.

## What changed since 1.10.13

The change repairs the local curtain's display host. The authorization
protocol, input filter, video encoder and capture engines are unchanged.

- Only the notice window is now a Windows Forms surface. The Agent remains a
  WPF application and reuses its existing UI dispatcher. No packages, extra
  UI thread, control authority or input hooks were added.
- Layered, click-through, no-activate, tool-window and topmost styles are set
  when the native window is created. Alpha is a constant 255. There is no
  per-pixel transparent renderer, transparency key or `UpdateLayeredWindow`.
- Every monitor window is prepared while hidden. Styles, opaque alpha, capture
  exclusion and pixel bounds are checked before any window is shown.
- First paint is bounded to two seconds. After all monitors have painted,
  styles, exclusion, visibility, handle identity and bounds are read back
  again. The second check does not silently reapply exclusion.
- The three existing notice lines, colors and layout are kept, including
  **Ctrl + Alt + Shift + Esc** and the **Ctrl + Alt + Del** instruction.
- A failure closes and disposes every prepared window. A window whose cleanup
  cannot be confirmed stays tracked, blocks unsafe capture and cannot produce
  a successful "curtain off" receipt.
- The GDI fallback shares a gate with first-show, so a fallback copy cannot
  race the notice appearing. When fallback capture is needed the controller
  still releases the curtain instead of transmitting the notice.
- Input pause still happens only after the display is verified. Receipts,
  grants, the five-second lease, local stop, explicit resume and
  release-on-disconnect are unchanged.

New source files: `agent/src/CurtainDisplaySession.cs`,
`agent/src/CurtainForm.cs`, `agent/src/CurtainNative.cs`. Changed:
`CurtainController.cs`, `CurtainOverlay.cs`, `ScreenCapture.cs`,
`ConnectLiveAgent.csproj`.

`agent/RUN-SOURCE.md` also has one wording update: the web console now shows
video and JPEG-fallback details behind a **?** button in the live viewer
instead of a permanent notice. That is a web console change and does not
alter Agent behavior.

The earlier explanation supplied from Lovable was used as historical
reference only. It names an older Agent revision as a candidate; it is not
proof that the curtain was hidden from the live stream in that revision.

## Checks run on 2026-11-15 (portable, not Windows)

Run from the workspace root:

```sh
dotnet run --project tests/curtain-display/CurtainDisplay.Tests.csproj
dotnet run --project tests/curtain-controller/CurtainController.Tests.csproj
node --test tests/control-curtain.cjs tests/input-pause.cjs
```

- **41 display-lifecycle checks passed.** The production display coordinator,
  result type and native declarations compile against .NET 8 with fake monitor
  surfaces. No Windows API is called and no window is rendered.
- **24 controller and lease checks passed.** The production controller
  compiles against inert display, input and dispatcher adapters.
- **22 browser-helper tests passed** for control/curtain receipts and input
  pause.

**Not performed:** compiling the Windows Forms notice or the full Windows
Agent, calling DWM or display-affinity APIs, showing a real curtain, physical
input, measuring live Windows video, or creating an installer.

## Windows acceptance still to be run by the owner

Use an explicitly authorized test PC and a separate technician browser. Do
not use a customer device. Record the actual Agent version, Windows build,
.NET runtime, display arrangement and scaling. Do not share pairing codes,
tokens or private desktop content.

From the extracted source on Windows:

```powershell
cd agent\src
dotnet run -- --pair
```

Confirm the startup log reports **1.10.14** before interpreting any result.
No installer build is needed for this test.

| Check | Required observation | Status |
| --- | --- | --- |
| Initial request | Browser stays pending until display and input are confirmed | Pending on Windows |
| Physical notice | Every monitor shows the full-screen notice with no uncovered edge | Pending on Windows |
| Live video | Technician sees the clean desktop, not the notice, a tint, a black rectangle or a frozen frame | Pending on Windows |
| Freshness | A seconds counter or moving window under the curtain keeps updating; cursor movement alone is not enough | Pending on Windows |
| Media paths | Check WebRTC and JPEG delivery separately; do not bypass the GDI safety release | Pending on Windows |
| Remote interaction | Authorized clicks and typing reach the application underneath; the notice never takes focus | Pending on Windows |
| Local input | Local input is paused only during confirmed curtain mode | Pending on Windows |
| Pause/resume | Pause control stops remote input while notice and live view remain; resume needs the explicit action | Pending on Windows |
| Local stop | Ctrl + Alt + Shift + Esc restores input, removes the notice and stops remote access | Pending on Windows |
| Windows security | Ctrl + Alt + Del remains available | Pending on Windows |
| Release/disconnect | Release, session end and lost renewal remove the notice and restore input within the lease | Pending on Windows |
| Display changes | Mixed-DPI and negative-origin monitors are covered; resolution change or hot-plug releases safely | Pending on Windows |
| Capture failure | DXGI loss releases the curtain before GDI fallback; the browser reports inactive or rejected | Pending on Windows |
| Rapid toggles | On/off/reconnect leaves no orphaned window or stuck input | Pending on Windows |

Compare the physical screen and the remote view at the same time. A photo of
the test PC's physical display is useful, because a screenshot taken on that
PC can omit the excluded notice.

Log lines on success:

```text
curtain display ready: windows=... exstyle_required=0x... affinity=0x11
privacy curtain applied: local notice rendered and input pause active
curtain receipt: action=curtain_on ... active=True
```

On failure keep the version and the exact diagnostics:

```text
curtain display rejected: reason=... native_error=...
curtain request rejected: action=curtain_on ... reason=... native_error=...
```

Agent logs are in `%LOCALAPPDATA%\ConnectLive\logs`.

## Boundary

Passing portable checks and a valid ZIP checksum do not show that the curtain
works on Windows. Until the table above is completed on a real PC, treat the
curtain repair as unverified.
