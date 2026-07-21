Enhance the admin-side control UI on the existing consent-based remote support session. This is purely a UI/UX improvement — no new agent capabilities, no new privilege escalation, no changes to the consent model, and no changes to what the agent accepts from the server.

## Scope

1. **Resizable trackpad** in the live-view modal (admin panel only)
2. **Slide-out on-screen keyboard panel** with common editing keys, hidden by default

All events use the existing `session_inputs` pipeline the agent already consumes when `mode === "control"` (and only then). The user-side banner and consent flow are unchanged.

## Changes (admin panel only)

### 1. Resizable `VirtualTrackpad` — `src/routes/_authenticated/admin.tsx`

Update the existing `VirtualTrackpad` component:
- Add a `size` state (default 128px, min 96, max 240)
- Add a small resize handle in the corner (bottom-left) — pointer-drag adjusts size
- Add compact `−` / `+` buttons as an alternative
- Persist size in `localStorage` (`connectlive:trackpad-size`) so admin doesn't reset it every session
- Keep the sensitivity multiplier proportional to size so movement feels consistent

### 2. Slide-out keyboard panel — `src/routes/_authenticated/admin.tsx`

Add a small tab/handle on the right edge of the live-view modal (only visible in control mode). Clicking it slides a compact panel out; clicking again hides it.

Keys, each sending existing `keydown` + `keyup` events via `sendInput(sessionId, ...)`:
- **Enter** (VK 13)
- **Backspace** (VK 8)
- **Delete** (VK 46)
- **Tab** (VK 9)
- **Escape** (VK 27)
- **Arrow keys** (37/38/39/40)
- **Ctrl+A** / **Ctrl+C** / **Ctrl+V** / **Ctrl+X** / **Ctrl+Z** — sent as sequenced `keydown(Ctrl) → keydown(letter) → keyup(letter) → keyup(Ctrl)` using the VKs already accepted by `InputRelay.Key(...)` (17 for Ctrl, 65/67/86/88/90 for letters)

No new agent code is needed — `InputRelay.cs` already handles `keydown` / `keyup` with a virtual-key code.

### 3. Small polish

- The panel is a plain `<div>` with `translate-x` transitions; no external dependencies
- Trackpad and keyboard both render only when `s.mode === "control"` and `s.device_id` is set
- Keyboard buttons have `onPointerDown` handlers (not `onClick`) so key repeat via holding works naturally

## Out of scope (explicitly)

- No changes to the agent binary or the zip
- No new server routes or migrations
- No changes to consent, banner, or session state machine
- No admin-privilege escalation, UAC prompting, or elevation logic on the agent
- No new inputs beyond mouse move / click / key down / key up that the agent already accepts

## Files touched

- `src/routes/_authenticated/admin.tsx` — extend `VirtualTrackpad`, add `OnScreenKeyboard`, wire the slide-out toggle

## Technical notes

- `sendInput` already inserts into `public.session_inputs`; RLS restricts inserts to authenticated technicians
- Ctrl+letter combos are sent as an explicit 4-message sequence to preserve modifier order on the agent's `SendInput` calls
- Sizes/persistence use `localStorage` guarded by a `useEffect` so SSR isn't a concern (the route is under `_authenticated`, which is `ssr: false`)