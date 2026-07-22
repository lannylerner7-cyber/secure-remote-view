## Goal

1. The 4 directional buttons on the trackpad **move the mouse cursor** on the remote (nudge / press-and-hold to glide), matching what the analog knob does — not fire keyboard arrows.
2. The "Left" / "Right" text labels on the click row are replaced with clear mouse-click glyphs so admins immediately read them as clicks (not directions).
3. Double-click reliably opens things on the remote (email message, file, folder) — timing tuned to Windows' `GetDoubleClickTime` window.
4. Enter (and every other OSK key) keeps working after the admin has been in control mode for minutes — no silent drop-off.

## Root causes (verified)

- `admin.tsx` L840-848 + L901-912: `ArrowBtn` sends `key_sequence` with VK 0x25-0x28. Those are keyboard arrows on the remote — they only "move" if a text field is focused, so on the desktop they do nothing visible. That's why "the 4 control button didn't move & shift the mouse".
- `admin.tsx` L897-899: click buttons are labelled with the words "Left" / "Right", which reads as direction next to a joystick. That's the "meaningless" text.
- `admin.tsx` L666-670 `onDoubleClick`: sends two `click` events back-to-back with no spacing. Agent's `Click()` (`InputRelay.cs` L271-275) runs down→up→down→up with zero delay — Windows Explorer/Outlook interpret bursts under a few ms as one click, so the double-click "works kind of different". Needs ~40-60ms between the two clicks (well under Windows' default 500ms threshold).
- Enter drop after long control: `sendInput` already dual-transports discrete events, so the DB path never drops. What drops is **focus**: after the admin scrolls the page, opens the notifications bell, or the OSK panel re-renders, `liveSurfaceRef` loses focus and physical Enter goes to the browser instead of the remote. On-screen Enter still fires, but only if the click actually hits the button; when the OSK panel re-collapses on hover-out it stops registering. Need: (a) refocus after every OSK press (already partially in place, verify), (b) re-arm focus on window blur/visibility change, (c) explicit `pointerdown` handler that survives panel re-renders.

## Changes — `src/routes/_authenticated/admin.tsx` only

### 1. Arrow buttons nudge the mouse

Replace the current `ArrowBtn` (which sends `key_sequence`) with a mouse-nudge button:

- On `pointerdown`: fire one `mousemove_rel` with a small step (e.g. `{dx: -12, dy: 0}` for ◀), then start a `setInterval(24ms)` that keeps sending the same delta with a mild acceleration curve (cap ~48px/tick) for as long as the pointer is held.
- On `pointerup` / `pointerleave` / `pointercancel`: clear the interval.
- Rename the callback prop from `onArrow(vk)` to `onNudge(dx, dy)`; delete the `VK_LEFT/UP/RIGHT/DOWN` constants inside `VirtualTrackpad`.
- Keep the same 3×3 grid layout so muscle memory is preserved.

### 2. Click row — icons, not directions

- Replace text "Left" → `🖱` glyph + tooltip "Left click" (or SVG left-mouse-button icon).
- Replace text "Right" → mirrored glyph + tooltip "Right click".
- Middle "Double" button stays but relabelled with tooltip "Double click (open)".
- No behavioural change to left/right click.

### 3. Reliable double-click

- Change `onDoubleClick` in the trackpad wiring (`admin.tsx` L666-670) to send a **single new event kind** `doubleclick { button: 0 }` OR keep the two `click` events but space them by 60ms via `setTimeout`.
- Chose the second option — no agent change needed. Payload: `sendInput(s.id, "click", { button: 0 })` then `setTimeout(() => sendInput(s.id, "click", { button: 0 }), 60)`. 60ms is well inside `GetDoubleClickTime` (default 500ms) and long enough for Explorer to treat the pair as a double-click.

### 4. Widen the tunnel so Enter never drops

- Add a `useEffect` on the admin panel that, whenever `s.mode === "control"`, listens on `window` for `visibilitychange` and `focus` and re-calls `focusLiveSurface()` — restores keyboard routing after the admin tabs away and back.
- In `OnScreenKeyboard`, change every key `<button>` from `onClick` to `onPointerDown` with `e.preventDefault()` so the browser never steals focus from the live surface between the down and up events. (Verify current state; some may already be pointerdown.)
- After each OSK press, call `focusLiveSurface()` — already wired at L674 but confirm it survives the panel's collapse/expand re-render.
- Keep the existing dual-transport (RTC + `session_inputs`) for all discrete events; no change there.

## Not changed

- No agent (`InputRelay.cs`) changes — `mousemove_rel`, `click`, and `key_sequence` all work correctly server-side; the ZIP does not need re-packing this turn.
- No API, DB, RLS, or migration changes.
- Keyboard panel content (Esc/Tab/Enter/Back/Del/Space/Home/End/Ctrl+…) stays as-is; only focus behaviour is hardened.
- Analog knob behaviour, resize handle, and hide/show pull-tab all stay as-is.

## Verification

1. `tsgo --noEmit` clean.
2. Manual (out-of-sandbox): hold ▶ on the trackpad → remote cursor glides right smoothly; tap Double on a highlighted email row → message opens; leave control mode focused for 5 min, tab to another browser tab and back, press Enter on the OSK → still lands on remote.

## Result

The four arrow buttons become a real cursor nudge pad (matching analog behaviour but precise), the click row reads as clicks not directions, Double reliably opens things, and Enter/OSK keys survive long control sessions.
