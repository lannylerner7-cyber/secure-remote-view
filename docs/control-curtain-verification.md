# Control and curtain correction

## Cause

The browser's former control button updated the session mode but did not
request the curtain. The Windows Admin combined the two actions.

There was also a protocol mismatch in Agent 1.10.5: acknowledged curtain
actions were routed to the transactional handler only for video-only sessions.
JPEG-enabled sessions fell through to a legacy receipt. That receipt omitted
the browser's session/grant fields and used a different message kind; it also
did not implement the browser's `curtain_renew` action.

## Current behavior

- The browser explicitly labels the operation **Take control + curtain**.
- Android keeps its control-only operation; Windows curtain requirements are
  not imposed on it.
- Server mode acceptance is only the first step. The current Agent must
  acknowledge control for the same session and authorization.
- The curtain is then requested. Input stays paused until a matching positive
  application receipt reports an active curtain.
- Cancellation and failure stop renewals, request safety cleanup and attempt
  view-mode rollback. A failed rollback is reported, not silently assumed.
- Release can request view mode without a connected peer. An unavailable
  curtain receipt is reported as unconfirmed.
- Permission loss, peer replacement and late acknowledgements cannot resume a
  cancelled request. Reconnection never automatically re-enables the curtain.
- State subscriptions provide cleanup functions; a timeout cannot mask its
  original error with an invalid unsubscribe call.
- JPEG pictures alone do not prove a command channel. The UI explains missing
  permission, channel, curtain support and unconfirmed curtain state.
- Agent 1.10.6 routes curtain actions identically for both media modes and
  retains the Windows Admin's original receipt ID spelling and renewal format.
- Receipt success follows actual rendered-window/input-pause completion.
  Native owner checks, visible local notice, emergency withdrawal and the
  five-second fail-safe lease remain in place. Released curtain input also
  releases remote-held keys/buttons.

This operation does not launch a Windows scheduled task or execute a script.
No customer device was operated to verify the change.

## Verification boundary

The focused control/media tests, browser protocol checks, console role/action
checks, static native checks and TypeScript checks pass. They are not evidence
of a real Windows display being covered.

The web production build passes. Signed-in checks with disposable fixtures and
a simulated Agent confirmed that control is requested before `curtain_on`,
that the UI waits for Agent acknowledgement, and that a missing acknowledgement
times out and returns the fixture to view mode. They exposed the unsubscribe
defect, which was corrected and covered by an adapter regression check.

The simulated browser checks did not complete the positive curtain receipt
and release journey within the acknowledgement deadlines. That success path
is covered by isolated protocol tests but remains unverified end to end.
The test fixtures were removed. No actual WebRTC/video or Windows rendering
claim is made from the simulated transport.

Agent 1.10.6 is delivered as complete source only. It has not been compiled,
installed or exercised on Windows in this workspace. No installer is produced,
and no GitHub push or production deployment is part of this update.
