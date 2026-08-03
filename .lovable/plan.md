# Verification pass: native admin keyboard + video rendering

Line-by-line re-read of the four files the plan touched. Three items match the plan exactly, two defects were introduced by the render change and one gap remains.

## Verified correct (no action)

- **Key handling** (`LiveSessionWindow.xaml.cs`): `OnKeyDown`/`OnKeyUp` set `e.Handled = true` only on the non-printable branch; printable keys return unhandled so WPF post-processing raises `TextInput`. `Effective(e)` (Alt via `SystemKey`) and the `_coalesce.FlushNow()` ordering are unchanged. The `_pendingPrintable` / `_textDelivered` stamp clears in `OnTextInput` and key-up sends raw `vk` down+up when nothing was composed.
- **Focus**: `Keyboard.Focus(this)` now runs on `Loaded` (plus `Activate()`), and the pre-existing `Keyboard.Focus(this)` in `Frame_MouseDown` is intact. The host `Grid` is `Focusable="True"` with `FocusVisualStyle="{x:Null}"`.
- **Injector contract**: `KeyboardInjector` / `InputTransport` untouched; `{ vk }` and `{ text }` payloads still match `agent/src/InputRelay.cs`. No agent-side or web-side change.
- **Rung numbers**: the edges mirrored into `LiveSessionViewModel` (1920/1600/1280/1024/800/640) match `agent/src/BitrateController.Ladder` exactly, and the `rung i/5` wording matches the agent's own ladder log line.
- **Scaling**: `RenderOptions.BitmapScalingMode="HighQuality"`, `UseLayoutRounding`, `SnapsToDevicePixels` are on the image and host grid; `VideoStats` is bound in the status bar.

## Defect 1 — `StretchDirection="DownOnly"` breaks click mapping at low rungs

`ContentRect.Compute` is the single geometry authority for clicks, wheel position and the ghost cursor. It computes `scale = min(elemW/srcW, elemH/srcH)` with no upper bound, which is only correct while the image really is stretched in both directions.

With `StretchDirection="DownOnly"`, a source smaller than the element (any rung at 1280px or below in a large or maximised window — exactly the case the rung readout exists to expose) is drawn at native size and centred, while `ContentRect` still assumes it was scaled up. Clicks land off-target and the ghost cursor drifts, and the error grows with the window/source ratio.

Fix: clamp the scale in `ContentRect.Compute` so the math matches the XAML, keeping one authority for both:

- add an `allowUpscale` parameter (default `false`) and `scale = Math.Min(scale, 1.0)` when upscaling is not allowed
- `Rect()` in `LiveSessionWindow.xaml.cs` calls it with the same policy the XAML declares
- extend the doc comment so the coupling between `StretchDirection` and this clamp is explicit

## Defect 2 — stale JPEG size leaks into the stats pill

`OnCurrentFrameChanged` records `_jpegW/_jpegH` only when the new frame is a `BitmapSource`. When the WebRTC path swaps in a `D3DImage` (`Pipeline.SurfaceReady`), the old JPEG dimensions stay latched, so a native session that is connected but not yet presenting reports the last fallback frame's size as if it were current.

Fix: in `OnCurrentFrameChanged`, zero `_jpegW/_jpegH` for any non-`BitmapSource` value.

## Gap — safety-net stamp is single-slot

`_pendingPrintable` / `_textDelivered` hold one key at a time. During fast overlapping typing (B pressed before A is released) the fallback can be skipped for B. Normal typing is unaffected — `TextInput` carries the characters — and the failure mode is only that the belt-and-braces path does not fire. Fix is to key the stamp per-`Key` in a small set rather than a single field.

## Files to change

- `admin/src/Media/ContentRect.cs` — scale clamp + parameter
- `admin/src/Views/LiveSessionWindow.xaml.cs` — pass the policy from `Rect()`; per-key fallback stamp
- `admin/src/ViewModels/LiveSessionViewModel.cs` — clear cached JPEG size on non-bitmap frames
- `PROJECT-MAP.md` — record the geometry/`StretchDirection` coupling under `SCOPE:RENDER`

No agent-side, web-side or transport changes.
