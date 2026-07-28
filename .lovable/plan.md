## What's actually happening (verified in the DB)

Your device `DESKTOP` currently has **six** rows in `sessions` that are all `state = 'active'` for the same device. Only the very first one (created at 18:58) has any frames in `session_frames` — 52 KB, last written at 19:57:43. Every session created after it (19:16, 19:33, 19:53 …) has **zero frames**.

That is the black screen. It is not a decoder bug, an RLS bug, or a missing column:

- Each time you click **Connect** in the admin (web or native), a brand-new `sessions` row is inserted with `state = 'invited'`.
- The agent is already busy pushing frames into the **original** session row (`db9ca3bc…`) and never notices that a newer invite exists for the same device, so it keeps writing frames to the old `session_id`.
- Admin polls `session_frames?session_id=eq.<new-id>` → 0 rows → `GetLatestFrameAsync` returns `null` silently → `CurrentFrame` never gets set → black `<Image/>`.
- No error is thrown, so the amber banner stays empty (matches "no banner" symptom).

The web console has the same shape because it polls by the new `session_id` too.

## Fix

Two changes, tightly scoped to the session-handoff seam. No schema changes.

### 1. Admin: reuse an existing live session for the device instead of stacking a new one

`admin/src/Api/ApiClient.CreateSessionAsync` and the web console's equivalent should:

1. Query `sessions?device_id=eq.<id>&state=in.(invited,active)&order=created_at.desc&limit=1`.
2. If a row exists **and** it belongs to the same technician (or the caller is super-admin), PATCH it: `state='active'`, `admin_client_id = App.ClientId`, refresh `updated_at`, and return it. That takes over the session cleanly using the mechanism already built.
3. If no row exists, INSERT as today.

This alone fixes the black screen for the common case (same technician reopens the device), because the admin will subscribe to the `session_id` that the agent is actually feeding.

### 2. Agent: honour a fresher invite for the same device

In `agent/src/Agent.cs` session-loop supervisor, on every heartbeat tick:

- Read the newest `sessions` row for this device where `state in ('invited','active')`.
- If its `id` differs from the loop's current `SessionId`, tear the current session loops down (mark old session `ended`), then start loops for the new one. This is the same `EnsureSessionLoops` path used on cold boot — just triggered when a newer row appears.

That covers the take-over case where a different technician (different `admin_client_id`) creates a fresh invite. Without it the agent would keep painting frames to the old session forever.

### 3. Admin: show "waiting for agent" when frame poll returns null

`FrameFallbackPump` currently only surfaces an error after 3 thrown exceptions. Empty results aren't exceptions, so the banner stays blank while the screen is black. Add: if 15 consecutive polls return `null` **and** WebRTC is not connected, call `onError("Waiting for agent to attach to this session…")`. Clear the banner on the first frame.

Apply the same "no frame yet" hint in the web console live view.

## Verification steps after the change

1. Manually end all stale active sessions for the DESKTOP device (one SQL update) so the agent starts clean.
2. Restart the Windows agent; confirm it lands on the newest invited/active session id.
3. Click Connect from the native admin — the live view should render within ~1 s over HTTP-poll and upgrade to WebRTC shortly after.
4. Click Connect from the web console on the same device — should render the same feed, no black screen.
5. Kill and restart the admin, connect again — should attach to the same session, no new stacked row.

## Out of scope

- No changes to WebRTC signaling, RLS policies, or the frame schema.
- No repackaging of the zips in this plan step; that comes after you approve and I implement.

Approve and I'll implement the three edits above and clean up the stale sessions.
