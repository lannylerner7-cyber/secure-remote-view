## Current verified state

- The latest session is `active` and the latest device is `online`.
- The consent route did accept the session (`session.consent_granted` exists).
- There are currently no rows in `session_frames` or `session_cursors`, so the admin live modal has no fresh pixels/cursor data to render. This points to the agent upload loops not running or failing after consent, not the admin image renderer itself.

## Plan

1. **Remove the allow/deny blocker from the live path**
   - Keep user-visible safety with the always-on session banner, tray end control, curtain icon/state, and live indicator.
   - Change the agent invite flow so an `invited` session immediately acknowledges the session as active and starts `ScreenCapture`, `InputRelay`, and `CursorPump` loops.
   - Avoid repeated modal prompts that can leave the backend `active` while the agent never starts streaming.

2. **Make session loops self-healing**
   - Add guard logic in the agent heartbeat dispatch: if the backend says a session is `active`, always ensure frame/input/cursor loops are running for that session.
   - If a loop crashes or upload returns repeated failures, log it and retry instead of silently leaving the admin stuck at “stalled”.

3. **Fix frame/cursor scale mismatch**
   - `ScreenCapture` currently streams at max edge 960 in performance mode, while `CursorPump` reports coordinates against 1280. Align them so the cursor overlay and live frame use the same coordinate system.

4. **Improve admin live recovery UI**
   - In the admin live modal, distinguish:
     - connected but waiting for first frame,
     - stalled frame upload,
     - device offline/reconnecting.
   - Add a lightweight “restart stream” action that reuses the existing session and sends safe cleanup commands (`curtain_off`, `release_inputs`) before waiting for the agent to rejoin.

5. **Verify route wiring end-to-end**
   - Re-check agent routes: heartbeat, consent/activation, frame, cursor, inputs, signal, reconnect.
   - Confirm the active session produces fresh `session_frames` and `session_cursors` rows after the agent starts.

6. **Repackage the Windows agent ZIP**
   - Update the bundle so the downloadable agent contains the fixed code and production URL.
   - Include the existing run/install scripts unchanged unless packaging requires refreshing the ZIP contents.