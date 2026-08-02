## Scope change

No trackpad or on-screen-pad widget in the native Admin. The native window uses the technician's **real mouse and keyboard** against the live image — those are the only input devices. The web console keeps its trackpad/OSK (touch/tablet path); the native client does not get them.

## What I compared

Native Admin (`admin/src/Views/LiveSessionWindow.xaml`, `LiveSessionViewModel.cs`, `Input/MouseInjector.cs`, `Input/KeyboardInjector.cs`) against the web console live modal (`src/routes/_authenticated/console.tsx`), both measured against what the agent actually accepts in `agent/src/InputRelay.cs` (lines 87–101).

| Control | Web console | Native Admin | Verdict |
|---|---|---|---|
| Mouse move | `mousemove` `{x,y}` | `mousemove_abs` `{x,y}` | **Dead** — agent has no `mousemove_abs` case |
| Mouse down/up | `{button: 0/2}` int | `{button:"left"/"right"}` string | **Dead** — agent reads `GetInt(p,"button")`, string parses to 0 |
| Wheel | `{dy}` | `{deltaX, deltaY}` | **Dead** — agent reads `dy` |
| Keyboard | `{vk}` numeric | `{code:"A",ctrl,shift,alt}` | **Dead** — agent reads `GetInt(p,"vk")` |
| Typed text | `unicode_text` | `text` | Works (agent accepts both) |
| Curtain | mode flip + `curtain_on` + **1s dead-man ping** | `curtain_on` once, no ping, separate mode button | Broken — `InputBlocker` watchdog (5s) auto-releases |
| Reconnect | session→active/view + `curtain_off` + `wake_agent{session_id}` | `wake_agent` only, no session id | Weak — agent may rejoin the wrong/no session |
| Restart stream / Restart agent | power commands | same | Works |
| Lock / Restart / Shutdown | with confirm | no confirm | Works, unguarded |
| End session | `release_inputs` + `curtain_off` + row update | `EndSessionAsync` only | Partial |
| Transport indicator | pill + RTP tooltip | `Transport` + `LinkState` | Works |

Bottom line: the native Admin's session buttons reach the agent; its **entire physical mouse/keyboard passthrough is silently dropped** because the payload field names and value types don't match what the agent reads.

## Plan (native Admin only — no agent or schema change)

1. **`Input/MouseInjector.cs`** — emit `mousemove` (drop `mousemove_abs`), `button` as int (`0` left, `2` right) on `mousedown`/`mouseup`, wheel as `{ dy }`. Real mouse movement over the live image then drives the remote pointer 1:1.
2. **`Input/KeyboardInjector.cs`** — translate the WPF `Key` to a Win32 virtual-key with `KeyInterop.VirtualKeyFromKey` and send `{ vk }` on `keydown`/`keyup`; keep `text` for typed characters so accented/IME input still works.
3. **`LiveSessionWindow.xaml.cs`** — send raw key events (including modifiers as their own vk down/up) so Ctrl/Alt/Shift combos land; keep `TextInput` for characters.
4. **`LiveSessionViewModel.cs`** — 1s `curtain_on` heartbeat while the curtain is engaged, cancelled on release/window close.
5. **Merge "Take control" + "Curtain"** into one button that flips `sessions.mode` and sends `curtain_on`/`curtain_off` together, matching the web console.
6. **`ReconnectAgent`** — flip the session to `active`/`view`, send `curtain_off`, and include `session_id` in the `wake_agent` payload.
7. **`Stop()`** — send `release_inputs` + `curtain_off` before ending the session.
8. **Confirm dialogs** on Restart/Shutdown, matching the web console.
9. Rebuild the Admin source zip (1.7.2) after the changes.

## Technical notes

Ground truth for payload shapes is the switch in `agent/src/InputRelay.cs`; the curtain watchdog is `InputBlocker.CheckWatchdog` with a 5s max age, fed only by `curtain_on` messages.
