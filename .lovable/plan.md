## Goal

Two layers working together:

1. **Backend boundary (who):** RLS scopes every session-scoped row to the owning `technician_id` so Admin A cannot read/inject Admin B's data.
2. **Routing perimeter (where):** every `ConnectLiveAdmin.exe` install carries a persistent `admin_client_id` (GUID) so the agent can route WebRTC/ICE/input to the exact physical admin machine, even when the same technician is signed in on two boxes — with an explicit "superseded" signal on take-over so the losing machine never freezes on a stale frame.

## 1. Persistent `admin_client_id` — installer stays dumb

- New file `%AppData%\ConnectLiveAdmin\client.id` alongside `session.dat`.
- On launch (`App.xaml.cs`, before `AuthStore` load):
  - Read the file; if missing/unreadable, generate `Guid.NewGuid().ToString("N")` and write it.
  - Expose `App.ClientId` for the whole process.
- Plain text — routing tag, not a secret. No install-time prompt, no per-user config.
- Survives sign-out, sign-in, and technician changes. Deleting the file (or copying `.exe` to a different Windows profile) yields a new perimeter — matches the "moved to a different machine = new poll" requirement. No webhooks, no server-side install registration; mapping happens at login time from `technician_id` (JWT) × `admin_client_id` (local file).

## 2. Schema additions (migration)

- `ALTER TABLE public.sessions ADD COLUMN admin_client_id text;` (nullable — web console leaves it null).
- `ALTER TABLE public.session_signals ADD COLUMN admin_client_id text;` — WebRTC signals filter per client so two admin machines never cross ICE offers.
- New signal kind allowed: `terminated` (payload `{ reason: "superseded_by_other_client" | "admin_ended" | ... }`).
- Indexes: `sessions (technician_id, state)`, `session_signals (session_id, admin_client_id, id)`.

## 3. RLS rewrite (security half)

Recreate policies on `session_frames`, `session_inputs`, `session_signals`, `session_cursors` so every staff read/write requires:

```sql
EXISTS (
  SELECT 1 FROM public.sessions s
  WHERE s.id = <table>.session_id
    AND (s.technician_id = auth.uid()
         OR public.has_role(auth.uid(), 'super_admin'))
)
```

- Keeps super_admin audit access.
- Agent path (`/api/public/agent/*`) uses the service role — unaffected.
- `sessions` policies already scope by `technician_id`; leave as-is.

## 4. `admin/src/Api/ApiClient.cs` changes

- `CreateSessionAsync(deviceRowId, mode, ct)` payload:
  ```json
  { "device_id": "...", "mode": "...", "state": "invited",
    "technician_id": "<AuthStore.Current.UserId>",
    "admin_client_id": "<App.ClientId>" }
  ```
- `PushSignalAsync` includes `admin_client_id` on every SDP/ICE/`bye` post.
- `PollAgentSignalsAsync` filter: `admin_client_id=eq.<id>` OR `admin_client_id=is.null` (back-compat with web console signals).
- New: watch for `kind=terminated` in the poll loop — surface it up to `LiveSessionViewModel` so the window can show a clear banner ("Session taken over by your other admin machine") instead of freezing on the last frame.
- `ListDevicesAsync` extended to fetch each device's active session `technician_id` + `admin_client_id` so the UI can render:
  - Available
  - "In session on this machine" → Resume
  - "In session by you on another machine" → Take over here
  - "In session by another admin" → disabled with owner name

## 5. Agent side (`agent/src/WebRtcSession.cs`, signal loops)

- Track the currently-negotiating `admin_client_id` on the active `WebRtcSession`.
- When an `offer` arrives with a different `admin_client_id`:
  1. Post a `terminated` signal to `session_signals` **targeted at the old** `admin_client_id` with `{ reason: "superseded_by_other_client" }`.
  2. Close the old `RTCPeerConnection` and cursor/input loops.
  3. Answer the new offer and route all subsequent input/ICE/cursor to the new `admin_client_id`.
- Signal outbound (agent → admin) also carries `admin_client_id` so the losing machine only reads signals meant for it.
- Single-viewer semantics — matches P2P model, keeps input mapping unambiguous.

## 6. Web console

- Signals without `admin_client_id` still accepted (web console has no perimeter).
- Devices list adds the same "This machine / Another machine / Another admin" badges purely from the new `admin_client_id` column.

## 7. Verification

1. Sign in on two Windows boxes as `197200`. Open the same device on box A → box B shows "Take over here". Take over on B; box A displays the "Superseded" banner (not a frozen frame), and box B streams cleanly.
2. Sign in a paired admin on box C. Create a session — succeeds (`technician_id` now set). Confirm C cannot read super_admin's frames/inputs (RLS).
3. Delete `%AppData%\ConnectLiveAdmin\client.id` → next launch generates a new GUID; the previous session on that box is treated as "another machine".
4. Web console (null `admin_client_id`) continues to receive frames/signals for its own sessions.
5. `scripts/verify-agent-routes.ts` still passes.

## Out of scope

- Multi-viewer/collab sessions (single-viewer per session preserved).
- Trusted-device enrolment for admin machines (`client.id` is a routing tag, not an auth factor).
- Any change to payments, orders, or agent enrolment.
- One Execution Detail for the Agent (Race Conditions)
  When implementing the "Take Over" teardown logic in ⁠agent/src/WebRtcSession.cs⁠ (Step 5), you must execute the sequence in a strict order to avoid a race condition:
  1. **Block old inputs:** Instantly stop processing any incoming cursor or keyboard commands from the old ⁠admin_client_id⁠.
  2. **Dispatch the signal:** Push the ⁠terminated⁠ signal out to your ⁠session_signals⁠ table targeting the old ⁠admin_client_id⁠.
  3. **Flush / Delay:** Ensure the HTTP POST or WebSocket push actually fires (a tiny 50ms ⁠Task.Delay⁠ can help here if your network layer is heavily buffered).
  4. **Tear down:** Close the ⁠RTCPeerConnection⁠ and dispose of the video capture and input hooks.
  5. **Rebuild:** Accept the new offer, initialize the new session for the new ⁠admin_client_id⁠, and send the WebRTC Answer.
  If you abruptly close the ⁠RTCPeerConnection⁠ and instantly spin up the new one before the ⁠terminated⁠ signal leaves the Agent's network buffer, the original machine might still freeze on a stale frame.