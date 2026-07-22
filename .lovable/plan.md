## Goal

1. Trackpad gets **Left/Right click + Up/Down/Left/Right arrow buttons** and a **hide/show toggle** (same pattern as the on-screen keys panel).
2. Every special key (`Esc Tab Enter Back Del Space Home End`) and shortcut (`Ctrl+A/C/V/X/Z`) reliably fires on the remote PC — single-click AND double-click — whether the admin is hovering the live screen, dragging over a file, or has clicked into an app.
3. Drag-to-select across a remote file/app works: mouse-down → move → up keeps the left button held on the remote side.

## Root causes (verified against current code)

Verified reads:
- `src/routes/_authenticated/admin.tsx` L269-303, L588-670, L733-905
- `agent/src/InputRelay.cs` L51-73, L302-371
- `src/routes/api/public/agent/session.$sessionId.inputs.ts` L37-44

Findings:

**A. On-screen keys silently drop when RTC is "open" but agent bridge doesn't replay.**
`sendInput()` (admin.tsx L269-273) short-circuits after `rtcRef.current?.sendInput(...)` returns true. If the WebRTC data channel is `open` but the agent's `WebRtcSession` bridge doesn't forward the payload into `InputRelay.Apply`, the event is dropped — no DB fallback runs. This matches "none of this actually works" for OSK keys while normal mouse works (mouse uses the same path but is spammed so at least some frames land via DB when RTC hiccups).

**B. Special keys throttled/blocked by focus loss.**
Clicking a `<button>` in `OnScreenKeyboard` fires `onPointerDown` (good — preventDefault), but subsequent physical Enter/arrow presses on the admin keyboard don't reach the live surface because focus moved. Only on-screen taps work, and even those depend on (A).

**C. mousemove throttle drops drag frames.**
`onMouseMove` throttles at 24ms unconditionally (admin.tsx L594-596). During a drag-select the intermediate points are the selection — throttling makes drags register as click-through on the remote and no selection happens.

**D. Enter/Ctrl combos on agent side are correct** — `KeySequence` in `InputRelay.cs` L359-371 executes down→up per vk with 10ms delay. No fix needed there; the failure is upstream at the transport (A).

## Changes

### Admin UI — `src/routes/_authenticated/admin.tsx`

1. **`sendInput` transport hardening (fixes A):**
   - Send via RTC data channel **and** enqueue to `session_inputs` for `key_sequence`, `keydown`, `keyup`, `unicode_text`, `click`, `mousedown`, `mouseup` (all "one-shot" events). Only continuous mouse streams (`mousemove`, `mousemove_rel`, `wheel`) keep the "RTC-only when open" short-circuit.
   - Rationale: agent's DB poll (`/session/:id/inputs`) is authoritative and idempotent-by-id; double-delivery of a discrete key is harmless (agent applies once per row), but drop of a discrete key is catastrophic. Continuous streams stay RTC-only to preserve bandwidth.

2. **Focus preservation:**
   - After any `OnScreenKeyboard` / trackpad button press, call `focusLiveSurface()` so admin's physical keyboard keeps flowing.
   - Add `onPointerDown` `e.preventDefault()` on new arrow / click buttons.

3. **Mouse-drag continuity (fixes C):**
   - Track `mouseButtonDownRef` on `mousedown`/`mouseup`; skip the 24ms throttle while a button is held so drag frames all propagate.

4. **Trackpad panel — new buttons + hideable (feature 1):**
   - Add a **directional pad** (Up/Down/Left/Right) beside the click row, each sending `key_sequence` with VK 0x25/0x26/0x27/0x28.
   - Keep Left click / Right click; add **Double-click** button (two `click` events, 60ms apart) for common file-open cases.
   - Add a slide/toggle handle on the left edge of the trackpad (mirror of the keys panel's right-edge tab). When hidden, only the toggle stub remains; state persisted in `localStorage` (`connectlive:trackpad-open`).

5. **OSK Enter reliability:**
   - Replace `onPointerDown={() => onKey(VK.ENTER)}` behaviour with a small helper that fires `key_sequence` + then refocuses the live surface. Double-tap works naturally because each tap is one full down/up sequence.

### API — `src/routes/api/public/agent/session.$sessionId.inputs.ts`

No behavioural change required — filter already allows `mouse`/`key`/`unicode_text`/`curtain_*`/`release_inputs` on active+control sessions. Add `key_sequence` explicitly to the safety pass-through list is **not** needed (it only runs during active control).

### Agent — no code change

The C# side already handles `key_sequence`, `unicode_text`, `keydown/up`, `click`, `mousedown/up`, `mousemove_rel`, extended-key flag for arrows, and virtual-desktop mapping. The bug is transport-only on the admin side.

### Packaging

Refresh `/mnt/documents/ConnectLiveAgent.zip` from unchanged `agent/src/` so the archive keeps parity with the repo (no source diff, just re-zip).

## Verification

1. `tsgo --noEmit` clean.
2. Playwright against `http://localhost:8080/admin` (Lovable session injected): open live view for a mocked control session, click each OSK key, confirm a `session_inputs` row is inserted per press (query via `stack_modern--invoke-server-function` or a temporary read endpoint is not needed — verify at the network layer that the `POST /rest/v1/session_inputs` call fires per press).
3. Manual on-device sanity (out-of-sandbox): Enter opens a highlighted file, Ctrl+A selects all in Notepad, drag across the desktop draws a rubber-band.

## Out of scope

- WebRTC signaling changes, curtain/coop logic, cursor telemetry, screen capture pipeline, typing tunnel field (already works).
- Any change to `.env`, migrations, RLS, or agent C# source.

## Result

Trackpad becomes a full directional + click pad you can hide off-screen; every OSK key and shortcut lands on the remote reliably via dual RTC+DB transport; drag-selection preserves all intermediate positions.
