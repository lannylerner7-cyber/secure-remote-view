## Goal

The admin "message to user" must NOT appear as an on-screen banner on the user's PC. It must behave purely as a **typing tunnel** — keystrokes injected into whatever app currently has focus on the remote machine (browser address bar, Notepad, search field, etc.).

## Current state (verified)

- `agent/src/InputRelay.cs` already implements `unicode_text` injection via `KEYEVENTF_UNICODE` — this is the typing tunnel path and works into any focused Windows control.
- `agent/src/InputRelay.cs` still handles legacy `note` events by forwarding them to `NoteOverlay`, which paints a banner on the user's screen.
- `agent/src/NoteOverlay.cs` exists and renders the banner window.
- `src/routes/_authenticated/admin.tsx` already sends `unicode_text` from the typing-tunnel field, but the backend input filter in `src/routes/api/public/agent/session.$sessionId.inputs.ts` still whitelists `note` on inactive sessions (from an earlier turn).

## Changes

### Agent (C#)
1. `agent/src/InputRelay.cs`
   - Remove the `case "note":` branch in the event dispatcher.
   - Remove any `NoteOverlay.Show/Hide` calls.
2. `agent/src/NoteOverlay.cs`
   - Delete the file (banner surface no longer needed).
3. `agent/src/Agent.cs` / `App.xaml.cs`
   - Remove any `NoteOverlay` construction, DI registration, or lifecycle hooks if present.

### Admin UI
4. `src/routes/_authenticated/admin.tsx`
   - Ensure the typing-tunnel field only emits `unicode_text` (and `key` for Enter/Backspace). Remove any residual `type: "note"` payload construction.
   - Relabel the field to "Type into focused app on user PC" so intent is unambiguous.

### API
5. `src/routes/api/public/agent/session.$sessionId.inputs.ts`
   - Drop `note` from the allowed event types. Only `mouse`, `key`, `unicode_text`, `curtain_on/off`, `coop_on/off` remain valid.

### Packaging
6. Rebuild `ConnectLiveAgent.zip` in `/mnt/documents/` with the updated `src/` (NoteOverlay.cs removed).
7. Run `tsgo --noEmit` to confirm the admin build is clean.

## Out of scope

- No changes to WebRTC, cursor telemetry, curtain mode, coop hooks, or trackpad math.
- No visual UI on the user's PC other than the existing consent + session indicator.

## Result

Admin typing goes straight into the remote focused control at native speed. Nothing overlays the user's screen from the message field.
