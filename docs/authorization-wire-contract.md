# Implementation contract: recorded endpoint authorization

This contract coordinates defensive implementation in inactive imported source.
It is not a claim that integration or runtime verification is complete.

## Wire format

The existing x-device-id/x-device-token authenticated Agent transport is used.
No new recurring permission prompts for explicitly granted unattended access.

POST `/api/public/agent/authorization`:
```
{
  "noticeVersion": 1,
  "mode": "attended" | "unattended",
  "capabilities": {
    "view": boolean,
    "control": boolean,
    "clipboard": boolean,
    "files": boolean,
    "recording": boolean
  }
}
```
The server derives device/owner identity and recorded time; the device attests to
local informed authorization. Control requires view. Unknown/missing fields fail
closed. Replacing a grant revokes old grant authority and ends existing sessions.
Response: `{ "ok": true, "authorization": <record below> }`.

GET on the same path returns `{ "authorization": <record or null> }`.
POST `/api/public/agent/authorization/revoke` revokes the current grant, ends its
sessions and returns `{ "ok": true }`. It is permitted with valid device identity
even after the grant is revoked; revocation must not require live-session access.

The existing heartbeat response gains `authorization`:
```
{
  "id": "<UUID>",
  "noticeVersion": 1,
  "mode": "attended" | "unattended",
  "capabilities": {"view":true,"control":false,"clipboard":false,"files":false,"recording":false},
  "recordedAt": "<ISO8601>",
  "revokedAt": null
}
```
Missing, malformed, revoked or unknown-version authority denies all live channels.
No legacy standing_consent flag or consent_at timestamp is a substitute.
The local endpoint must retain its matching grant id, mode and scopes; a remote
record alone must never create or broaden local authorization.

Session consent POST additionally sends `authorizationId` and `noticeVersion:1`.
The server checks that the grant is current, unrevoked and permits requested mode.
The session stores its authorizing grant id. Unattended sessions require no
recurring dialog within the grant; attended acceptance still occurs locally.

## Local UI and enforcement

Foreground enrollment/reauthorization presents explicit mode and independent
scope choices, unchecked by default, with no hidden/background autoaccept.
Persist the matching grant locally, protected for the current Windows user.
An existing enrollment without this record remains dormant until foreground
authorization. Match device identity and API origin as well as grant id.

On heartbeat scope mismatch, grant replacement/revocation, pause, end or local
disable: invalidate old session authority, stop capture/input/transfers/clipboard,
release held/blocking input and close peer channels. Presence is not capture.
Local disable takes effect regardless of server connectivity.
Restarts/watchdog cannot undo local withdrawal.

UI/runtime limits must be reported explicitly. Do not fabricate grants, real
consent evidence or successful runtime tests. No services/production are activated.
