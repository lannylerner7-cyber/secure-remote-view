# ConnectLive access-policy contract

This is the implementation contract. Staged enforcement and verification limits
are documented in `docs/import-verification-delivery.md`; it is not activated.
Preserve the existing architecture. No performance or live rollout work precedes
verification of these controls.

## Modes and grants

- Attended: accept each requested session before any capture/control.
- Unattended: one explicit enrollment grant permits future sessions within its
  scope, without repeated prompts during ordinary authorized operation.
- A grant identifies device, owner, authorizing person, notice version, time,
  mode, allowed capabilities and withdrawal state. Installing software, supplying
  a Meeting ID or an old server session state is not a substitute for that record.
- Viewing and control are separate. Clipboard, files and recording require
  their own recorded scopes. Unknown capabilities are denied.
- New grants or scope expansion require explicit authorization, outside a
  presentation rather than an unsolicited mid-session prompt. Required OS
  prompts cannot be bypassed.
- Legacy devices without evidence remain restricted until explicit enrollment
  authorization. Do not fabricate historical permission.

## Lifecycle matrix

| Event | Capture/view | Control | Clipboard/files | Presence |
| --- | --- | --- | --- | --- |
| Enrolled, idle | Off | Off | Off | Allowed if management enabled |
| Authorized view session | Within viewing grant | Off | Only separately granted scopes | On |
| Authorized control session | Within viewing grant | Within control grant | Only separately granted scopes | On |
| Pause | Off | Off; release held input | Off | May remain on |
| Admin End live | Off | Off; release held input | Off | May remain on |
| Repeated heartbeat failure | Off | Off; release held input | Off | Retry only while management enabled |
| Permission revoked | Affected capabilities off | Affected capabilities off | Affected capabilities off | Only if separately still authorized |
| Management disabled/uninstalled | Off | Off | Off | Off; no recovery undoing the choice |
| Reconnect | Revalidate grant and server state | Revalidate mode and scope | Revalidate scope | No revival after withdrawal |

End live does not mean continue viewing. A separate view-only session may be
started only within its explicit authorization. Persistent status should expose
technician identity, active capabilities and local stop/revocation actions
without routine modal interruptions.

## Checks still required

Server and endpoint must enforce the same grant. Peer callbacks, queued input,
transfers and capture loops must check the current authorization epoch, not only
their initial session state. Teardown must invalidate in-flight work and verify
that it has stopped. Authorization failures must not be repaired by automatic
reenrollment that silently restores withdrawn access.

Staged source now includes grant records, foreground authorization, protected
local matching, receiver scopes, server/database guards and session invalidation.
Cross-builds and isolated checks do not establish real database, Windows or
end-to-end enforcement; those delivery gates remain explicit in the report.
