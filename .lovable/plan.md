# Native admin: keyboard dead + picture soft

## 1. Typing does nothing in the native console (confirmed root cause)

`admin/src/Views/LiveSessionWindow.xaml.cs` wires `PreviewKeyDown` / `PreviewKeyUp` / `TextInput`. Both key handlers set `e.Handled = true` for **every** key, then `return` early for printable keys, on the assumption that `TextInput` will carry the character.

WPF never raises `TextInput` for a key whose `KeyDown` was marked handled — text composition is generated during post-processing of the key event, and a handled key event is skipped. So printable keys are swallowed by the `return`, and `TextInput` never fires: nothing is sent for letters, digits, punctuation or space. Only non-printable keys (Enter, Tab, arrows, Ctrl/Alt combos) reach the agent — which matches "can't type" while the web console, which has its own `keyToVirtualKey` path, works fine.

Fix in `LiveSessionWindow.xaml.cs`:

- `OnKeyDown` / `OnKeyUp`: mark `e.Handled = true` **only** for non-printable keys. Leave printable keys unhandled so WPF produces the `TextInput` event that carries the Unicode character.
- Keep `Effective(e)` (Alt combos via `SystemKey`) and the existing `_coalesce.FlushNow()` ordering unchanged.
- Add a safety net: if no `TextInput` arrives for a printable key within the same input cycle, fall back to sending the raw virtual key. Implemented by stamping the key in `OnKeyDown` and clearing that stamp in `OnTextInput`; on `OnKeyUp` a still-set stamp sends `vk` down+up. This covers layouts/dead keys where WPF suppresses composition.
- Ensure the live surface actually holds keyboard focus: set `Focusable="True"` on the window content and call `Keyboard.Focus(this)` on `Loaded` as well as on mouse-down (today it happens only on mouse-down, so a session you never clicked into gets no keys at all).

No change to `KeyboardInjector` / `InputTransport` — their `{ vk }` and `{ text }` payloads already match `agent/src/InputRelay.cs`.

## 2. Soft / blurry picture

The screenshot's status bar reads `Realtime frames · stalled 4s`, so that session was on the JPEG fallback pump, not WebRTC. Two contributors, both addressed:

**a. WPF scaling quality.** `FrameImage` uses `Stretch="Uniform"` with no scaling hint, so WPF uses its default (bilinear) filter and non-integer layout, which smears text when a 1920-wide source is drawn into a ~1080-wide element. Set on the `Image` in `LiveSessionWindow.xaml`:

- `RenderOptions.BitmapScalingMode="HighQuality"` (Fant — the right filter for downscaling text)
- `UseLayoutRounding="True"` and `SnapsToDevicePixels="True"` on the hosting `Grid`
- `Stretch="Uniform"` plus `StretchDirection="DownOnly"` so a small source is never blown up into mush

**b. Adaptive rung not visible.** `BitrateController`'s ladder drops to 1280/1024/800px on any RTCP loss or slow upload, and once dropped there is nothing on screen saying so — a soft picture looks like a renderer bug. Surface it: include the rung (`1920px rung 0/6`) in the `VideoStats` line the title bar already binds, sourced from the fallback pump's reported frame size for the JPEG path and from `VideoPipeline.SourceWidth/Height` for the WebRTC path.

This tells us, on the next run, whether the softness is the ladder having stepped down (a link problem) or the presenter. I am not claiming which yet — the rung readout is the measurement that decides it.

## Files touched

- `admin/src/Views/LiveSessionWindow.xaml.cs` — key handling, focus, fallback vk path
- `admin/src/Views/LiveSessionWindow.xaml` — scaling mode, layout rounding, stretch direction
- `admin/src/ViewModels/LiveSessionViewModel.cs` — rung / source-size in `VideoStats`
- `PROJECT-MAP.md` — note the input + render fixes

No agent-side or web-side changes; the web console keeps working exactly as it does now.
