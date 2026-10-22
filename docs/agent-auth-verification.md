# Agent hello / Windows Hello authorization review — 2026-10-22

## Distinct mechanisms

Windows Hello is the operating system's PIN/biometric sign-in. The inspected
Agent/Admin source contains no dedicated Windows Hello, WebAuthn or credential
provider integration. ConnectLive's POST `/api/public/agent/hello` instead
reports device presence; it does not authenticate a user to Windows or unlock it.

## Verified

- Actual hello endpoint on both workspace and https://connectliveagent.com
  rejected missing credentials, device-ID-only and an invalid token for a
  nonexistent device, returning 401 in all six cases. No valid device/session
  credentials or account passwords were used, and no successful write was
  requested. HTTP access logs may record these requests.
- Current source calls verifyDevice before updating presence or appending the
  hello audit event. It derives the target device from the verified record,
  rather than a caller-supplied body ID.
- 44 server authorization checks and 18 recorded-authorization handler checks
  passed with mocked database/RPC implementations. Revoked/missing/wrong grants,
  separate view/control/files scopes and unauthorized ownership are covered;
  these are not live SQL/RLS or Windows tests.
- 22 portable native transport/config policy checks passed. These do not test
  the Windows Hello UI or the full native session lifecycle.
- Agent manifest uses asInvoker with uiAccess=false. Input relay checks control
  scope at dispatch/application. InputBlocker releases on session lock/logoff/
  disconnect. DXGI handles access loss and tears down duplication when the
  desktop changes. These observations are not proof of OS-level bypass immunity.

## Findings and limits

No authentication bypass was demonstrated in the checks above. This is not a
claim that all bypasses are absent. A valid device hello token permits presence
reporting; screen/control authority is separate and session/grant-based.

The hello handler currently ignores Supabase update/insert error results, so an
authenticated request may report success despite a failed presence/audit write.
That is a reliability issue, not evidence of Windows sign-in bypass. It was not
changed during this verification.

No Windows device was available. Lock/unlock, PIN/biometric prompts, UAC secure
desktop, first frame after legitimate local unlock, local revocation while
locked, and reconnect after lock require authorized Windows testing. No PIN,
biometric, secure-desktop or OS authentication bypass was implemented or tested.
No successful live hello, enrollment, screen capture or control session ran.
