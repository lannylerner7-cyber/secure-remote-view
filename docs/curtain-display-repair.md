# Local-only curtain: source repair and Windows acceptance

## Scope and evidence

This source change increments the Agent from **1.10.13 to 1.10.14**. It repairs
the curtain display host, not the authorization protocol, input filter, video
encoder, browser layout, or native Admin.

Before editing, the curtain/controller/input/capture/receipt sources, Agent
project, and browser curtain/control helpers were compared byte-for-byte with
GitHub `main` at `6d62e5f6c177164d48e757bbb25933cd8e939b50`; they matched.
No GitHub write or deployment was part of the repair itself.

**Later on 2026-11-15** this source was published to GitHub `main` as a
separate release step, together with the web viewer's **?** help popup. That
publication does not change the evidence below: nothing here was built or run
on Windows, and no deployment was verified.

Lovable's explanation is historical reference only. It identifies Agent 1.2.0
at `170f51330f8760266e5c48a2008d105eb40e8ab4` as a candidate, not a physically
verified working release. It describes an unchecked display-affinity call and
an optimistic browser notification. Neither proves that the physical notice
was absent from the live stream, nor disproves the owner's earlier observation.

The supplied real rejection log was from **1.10.12**. The later opaque-WPF
configuration was inspected in source; its behavior on that Windows PC was not
measured. Do not mix those versions or present a source hypothesis as a proven
driver diagnosis.

## What changed

- Only the notice window is now a Windows Forms surface. The Agent remains a
  WPF application and reuses its existing UI dispatcher/message pump. No
  packages, extra UI thread, control authority, or new input hooks are added.
- Layered, click-through, no-activate, tool-window, and topmost styles are
  present at native window creation. Constant alpha is 255; there is no
  per-pixel transparent WPF renderer, transparency key, or `UpdateLayeredWindow`.
- All monitor windows are prepared while hidden. Styles, opaque alpha,
  capture exclusion, and native pixel bounds are checked before any is shown.
- First-paint completion is bounded to two seconds. After every monitor has
  painted, composition is flushed and styles, exclusion, visibility, handle
  identity, and bounds are checked again. The post-paint check reads back
  exclusion; it does not silently reapply it after a gap.
- The three existing notice lines and their colors/layout are retained,
  including **Ctrl + Alt + Shift + Esc** and the Windows **Ctrl + Alt + Del**
  instruction. Monitor origins can be negative; sizing uses physical pixels,
  while text scales with the window DPI.
- Failure closes and disposes every prepared window. Cancellation cannot
  remove a newer explicit activation. A window whose cleanup cannot be
  confirmed remains tracked, blocks unsafe capture, and cannot produce a
  successful off receipt.
- The existing GDI fallback now shares a small gate with first-show. A GDI
  copy already underway finishes before the notice appears; later fallback
  copies cannot race a separate `IsShown` check. Capture engines and codecs
  are unchanged. When fallback is needed, the existing controller still
  releases the curtain rather than transmitting a banner or black frame.
- Input pause still happens only after display verification. Matched receipts,
  current grants, five-second leases, local stop, explicit resume, and
  release-on-disconnect remain in place.

The framework rationale is based on the distinction between constant-alpha
and per-pixel layered windows:

- [Microsoft explanation of WPF layered-window display affinity](https://learn.microsoft.com/en-us/archive/msdn-technet-forums/7ce400f0-ebda-4b95-869c-85b5b93f972d)
- [.NET 8 Windows Forms source](https://github.com/dotnet/winforms/blob/v8.0.0/src/System.Windows.Forms/src/System/Windows/Forms/Form.cs)

API acceptance and painting completion are necessary checks, **not proof of
what a real capture driver transmits**. The physical checks below remain the
release gate for claiming this issue resolved.

## Portable regression commands

From the workspace root, not from the imported repository root:

```sh
dotnet run --project tests/curtain-display/CurtainDisplay.Tests.csproj
dotnet run --project tests/curtain-controller/CurtainController.Tests.csproj
node --test tests/control-curtain.cjs tests/input-pause.cjs
```

The display harness compiles the production display coordinator, result type,
and native declarations. Fake monitor surfaces exercise prepare/show/paint/
verify ordering, multi-monitor cleanup, native-error propagation, timeout,
generation cancellation, disposal failures, and the capture gate. It does not
invoke Windows APIs or render a form.

The controller harness compiles the real controller and lease with inert
display, input, and dispatcher adapters. It covers receipt ordering, display
failure before input pause, failed input pause after rendering, late
completion, unconfirmed cleanup, capture-fallback release, local withdrawal,
and lease expiry. Browser helper checks are isolated protocol tests, not a
signed-in browser or Windows session.

These checks are not a full Agent build. No Windows client executable or
installer is compiled or published here.

### Recorded verification — 2026-11-15

- **41 display-lifecycle checks passed**, compiling the real coordinator and
  native declarations against .NET 8 with inert monitor surfaces.
- **24 controller/lease checks passed**, compiling the production controller
  against inert input/display/dispatcher adapters.
- **22 browser-helper tests passed** for control/curtain receipts and input
  pause. The web implementation was not changed.
- `git diff --check` passed. The existing public technician sign-in page also
  rendered normally; that screenshot does not validate the Windows notice.
- **Not performed:** compiling the Windows Forms renderer or full Windows
  Agent, invoking DWM/display-affinity APIs, displaying a real curtain,
  exercising physical input, measuring live Windows video, creating an
  installer, pushing to GitHub, or deploying.

## Manual Windows acceptance

Use an explicitly authorized test PC and a separate technician browser. Do
not use a customer device as an implicit test. Record the **actual** Agent
version, Windows build, .NET runtime, display arrangement/scaling, capture
source, and tested media path. Do not include pairing codes, tokens, or private
desktop content in shared evidence.

From the complete updated source tree on Windows:

```powershell
cd agent\src
dotnet run -- --pair
```

Confirm that the startup log identifies **1.10.14** before interpreting any
result. No installer build is needed for this test.

| Check | Required observation | Evidence status |
| --- | --- | --- |
| Initial request | Browser stays pending until display and input confirmation; no optimistic success | Pending on Windows |
| Physical notice | Every monitor shows the existing full-screen notice, with no uncovered edge or clipped stop instructions | Pending on Windows |
| Live video | Technician sees the clean desktop, not the notice, tint, black rectangle, or a substituted frozen frame | Pending on Windows |
| Freshness | A visible seconds counter or moving test window underneath keeps updating during curtain mode; cursor movement alone is insufficient | Pending on Windows |
| Media paths | Check WebRTC and the existing JPEG delivery path separately; do not bypass the GDI safety release to force a pass | Pending on Windows |
| Remote interaction | Authorized clicks and typing reach the application underneath without the notice taking focus | Pending on Windows |
| Local input | Ordinary local input is paused only during confirmed curtain mode | Pending on Windows |
| Pause/resume | Pause control stops remote input while the notice and live view remain; resume requires the explicit authorized action | Pending on Windows |
| Local stop | Physical Ctrl + Alt + Shift + Esc restores input, removes the notice, and stops remote access; no automatic reactivation | Pending on Windows |
| Windows security | Ctrl + Alt + Del remains available; no Windows security prompt or boundary is bypassed | Pending on Windows |
| Release/disconnect | Release, session end, and loss of renewal remove the notice and restore input within the existing lease boundary | Pending on Windows |
| Display changes | Mixed-DPI/negative-origin monitors are covered correctly; resolution changes and hot-plug release safely and require explicit reactivation | Pending on Windows |
| Capture failure | DXGI loss/GDI fallback releases the curtain before fallback capture; the browser reports inactive/rejected rather than remaining engaged | Pending on Windows |
| Rapid toggles | On/off/reconnect does not leave orphaned windows, stuck input, or an old completion hiding a newer curtain | Pending on Windows |

Compare physical and remote views simultaneously. A photo of the authorized
test PC's physical display is useful because a screenshot made on that PC may
itself omit the excluded notice.

On success, relevant log lines include:

```text
curtain display ready: windows=... exstyle_required=0x... affinity=0x11
privacy curtain applied: local notice rendered and input pause active
curtain receipt: action=curtain_on ... active=True
```

On failure, retain the version plus the exact bounded diagnostics:

```text
curtain display rejected: reason=... native_error=...
curtain request rejected: action=curtain_on ... reason=... native_error=...
```

DWM failures additionally report `hresult=0x...`; an HRESULT is not a
`GetLastError` code. A missing `native_error` can mean a successful query
returned the wrong state, not that the failure was suppressed.

**Current boundary:** source repair and portable checks are separate from a
Windows build, physical input/display test, stream exclusion test, GitHub
release, and deployment. None of those Windows or release claims should be
inferred from this document.
