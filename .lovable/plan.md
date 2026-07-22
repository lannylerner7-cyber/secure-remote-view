Build a focused input-relay upgrade so admin control feels like a real local mouse/keyboard session.

&nbsp;

1. Admin live-view input capture

- Make the live screen wrapper, not just the `<img>`, own keyboard focus during control mode.
- Focus it automatically when control is enabled or the admin clicks/touches the remote screen.
- Use modern `event.key` / `event.code` mapping instead of deprecated `keyCode`, so Enter, Backspace, Delete, arrows, Ctrl+A/C/V/Z/X, Tab, Escape, and printable text are sent correctly.
- Keep mouse click-to-position working, but throttle high-frequency mousemove inserts so the database is not flooded while still feeling smooth.

2. Replace the “shared message” behavior with a typing tunnel

- Change the bottom text field from “message shown to user” into “type to remote PC”.
- When the admin types there, send the characters to the remote focused app using real keyboard/Unicode input, not an overlay banner.
- Support Enter, Backspace, Delete, Tab, Ctrl+A/C/V/Z/X, and paste-style text entry.
- Stop relying on the current `note` overlay for this field, since that displays text on-screen instead of typing into Notepad/browser fields.

3. Mouse movement controls

- Treat the analog/trackpad as the main pointer-movement control.
- Remove or repurpose the on-screen up/down/left/right buttons so they no longer pretend to move the mouse while actually sending keyboard arrow keys.
- Increase analog movement cadence/speed curve so small movement is precise and full deflection moves fast enough.
- Keep left/right click buttons and direct click-on-screen mapping.

4. Agent-side Windows input relay

- Add a dedicated `text` / `unicode_text` event path that uses `SendInput` with `KEYEVENTF_UNICODE`, so typing works in Notepad, browser address bars, forms, and normal Windows apps.
- Improve shortcut handling by sending modifier down events first, the target key next, then releases in reverse order.
- Keep existing safety commands (`curtain_on`, `curtain_off`, `release_inputs`) untouched.
- Keep the low-level hook signature so admin-injected input passes curtain mode while physical user input is blocked only when curtain is active.

5. Transport and fallback behavior

- Send inputs through WebRTC data channel when available for lowest latency.
- Keep the existing HTTPS polling path as fallback so control still works when WebRTC fails.
- Allow text/keyboard/mouse input in active control sessions; keep non-control mode safe unless explicitly needed for text-only co-op.

6. Verification package

- Recheck all input event names across admin UI, `/api/public/agent/session/:id/inputs`, `ApiClient`, and `InputRelay`.
- Verify the Windows agent builds cleanly.
- Repackage the updated agent zip with the same project URL and updated source.
- 1. The Typing Tunnel (`KEYEVENTF_UNICODE`)
  Right now, your C# agent is likely trying to simulate typing by converting characters into virtual key codes (`wVk`). This breaks instantly when typing uppercase letters, special symbols, or non-English characters.
  The Windows research on this is clear: **Do not simulate keystrokes for text entry.** Instead, you use the `KEYEVENTF_UNICODE` flag. This tells the Windows OS: *"Do not worry about what physical key on the keyboard was pressed. Just inject this exact Unicode character directly into whatever application currently has focus."*
  ### C# Implementation
  In your `InputRelay.cs` (or wherever your `SendInput` logic lives), create a dedicated method for the new `unicode_text` event payload.
  C#
  ```
  // Win32 Constants
  private const uint KEYEVENTF_UNICODE = 0x0004;
  private const uint KEYEVENTF_KEYUP = 0x0002;

  public void InjectUnicodeString(string text)
  {
      // Each character requires 2 inputs: KeyDown and KeyUp
      INPUT[] inputs = new INPUT[text.Length * 2];
      int index = 0;

      foreach (char c in text)
      {
          // 1. Key Down Event
          inputs[index] = new INPUT { type = INPUT_KEYBOARD };
          inputs[index].u.ki.wVk = 0; // MUST be 0 for Unicode
          inputs[index].u.ki.wScan = c; // Pass the raw character
          inputs[index].u.ki.dwFlags = KEYEVENTF_UNICODE;
          inputs[index].u.ki.dwExtraInfo = CONNECTLIVE_INPUT_MAGIC; // Bypasses your hook!
          index++;

          // 2. Key Up Event
          inputs[index] = new INPUT { type = INPUT_KEYBOARD };
          inputs[index].u.ki.wVk = 0;
          inputs[index].u.ki.wScan = c;
          inputs[index].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
          inputs[index].u.ki.dwExtraInfo = CONNECTLIVE_INPUT_MAGIC;
          index++;
      }

      // Send the entire string as one atomic batch
      SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  ```
  **Admin UI Update:** Transform your "share message" text field. When the admin types into it, capture the string on `Enter` (or on every keystroke, depending on preference) and send a `{"type": "unicode_text", "text": "..."}` payload to the agent via WebRTC (with HTTPS fallback).
  ## 2. Admin Live-View & Shortcut Sequencing (Ctrl+A / Ctrl+V)
  If `Ctrl+A` or `Enter` is failing, it is because of two things:
  1. The web browser's `<img>` or `<canvas>` wrapper does not have keyboard focus, so it isn't catching the events.
  2. The C# agent is receiving the keys in the wrong order.
  ### React (Admin UI) Fix: Focus & Modern Events
  Add `tabIndex={0}` to your screen wrapper `<div>`. When the admin clicks "Take Control", programmatically call `.focus()` on that ref.
  Stop using `event.keyCode` (it is deprecated). Use `event.key` to determine the character and `event.code` to determine the physical key location. Listen to both `keydown` and `keyup` on the wrapper.
  JavaScript
  ```
  // Example React Event Handler on the wrapper div
  const handleKeyDown = (e) => {
      e.preventDefault(); // Stop the browser from scrolling or tabbing away

      const payload = {
          type: "key_event",
          action: "down",
          key: e.key,        // e.g., "Enter", "a", "Control"
          code: e.code,      // e.g., "KeyA", "ControlLeft"
          ctrl: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey
      };
      
      // Send via WebRTC DataChannel (lowest latency), fallback to API polling
      sendInputToAgent(payload);
  };

  ```
  ### C# Agent Fix: Shortcut Sequencing
  When sending shortcuts like `Ctrl+A`, the order of `SendInput` execution is highly strict. You must press the modifiers down, press the target key down, release the target key, and then **release the modifiers in reverse order**.
  C#
  ```
  // Example sequence for Ctrl + A
  List<INPUT> inputs = new List<INPUT>();

  // 1. Modifiers DOWN
  inputs.Add(CreateKeyInput(VK_CONTROL, isDown: true));

  // 2. Target Key DOWN
  inputs.Add(CreateKeyInput(VK_A, isDown: true));

  // 3. Target Key UP
  inputs.Add(CreateKeyInput(VK_A, isDown: false));

  // 4. Modifiers UP
  inputs.Add(CreateKeyInput(VK_CONTROL, isDown: false));

  SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));

  ```
  ## 3. Mouse Movement: The Analog Trackpad
  The bug where the up/down/left/right buttons were sending keyboard arrows instead of moving the mouse natively must be stripped out entirely.
  To make the mouse feel native, treat the UI Analog stick exactly like a laptop trackpad sending **relative deltas**, not absolute screen coordinates.
  1. **Remove Arrow Keys:** The analog stick should never trigger `VK_UP` or `VK_DOWN`.
  2. **Speed Curve Math (React side):** When the admin pushes the analog stick slightly, send small `[dx, dy]` values (e.g., `dx: 2, dy: 0`). When pushed to the edge, multiply the output heavily (e.g., `dx: 45, dy: 0`).
  3. **Throttling:** Do not send a JSON payload for every single pixel of movement. Use `requestAnimationFrame` or a simple throttle to batch the `dx/dy` additions every 16ms to 30ms. This prevents your WebRTC channel or HTTPS fallback from flooding and disconnecting.
  4. **C# Injection:** When the agent receives a relative mouse move, use the `MOUSEEVENTF_MOVE` flag without the `MOUSEEVENTF_ABSOLUTE` flag.
  C#
  ```
  INPUT mouseMove = new INPUT { type = INPUT_MOUSE };
  mouseMove.u.mi.dx = payload.dx;
  mouseMove.u.mi.dy = payload.dy;
  mouseMove.u.mi.dwFlags = MOUSEEVENTF_MOVE;
  mouseMove.u.mi.dwExtraInfo = CONNECTLIVE_INPUT_MAGIC; // Pass through the hook!

  SendInput(1, new[] { mouseMove }, Marshal.SizeOf(typeof(INPUT)));

  ```
  ## 4. Verification & Fallback
  By isolating the `unicode_text` pipeline from the `key_event` pipeline, and switching the mouse logic to pure `dx/dy` relative movement, you decouple the UI from legacy workarounds.
  - **The Hooks:** Because you are signing every `SendInput` payload with your `dwExtraInfo` magic pointer, your Low-Level Hooks from the previous architecture will naturally allow all of these new text, shortcut, and mouse movements to pass instantly, even when the curtain is blocking the local user.
  - **The Transport:** Pipe all these events over the WebRTC Data Channel if `rtcConnection.readyState === 'open'`. If it is closed, append them to a queue that the HTTPS fallback flushes every 200ms.