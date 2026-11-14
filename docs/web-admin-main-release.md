# Web-admin GitHub main release

## Scope

This release updates the technician web console and its supporting permission
and diagnostic handlers. It does not release the workspace's sandbox checkout
or update the Windows Agent/Admin source or installed binaries.

Included:

- Eight labeled session tools with a responsive selector and persistent session
  status/actions; switching tools preserves the live media and operation state.
- Receiver-confirmed Pause control / Resume control on compatible Agents,
  distinct from local Pause viewer. Unsupported Agents do not claim confirmed
  input pause.
- Current-role checks when confirming remote control, and read-only session-table
  restrictions.
- Recovery keeps input restricted until deliberate authorized resume.
- Separate H.264 encode timing in heartbeat metadata, rather than counting it
  as VP8.
- Focused web protocol, role, layout, recovery and diagnostic regression tests.

## Preserved

The upstream checkout, payments, invoices, pricing, public site, route registry,
dependency manifests and lockfile, deployment configuration, database migrations,
and native clients are preserved. No database operation is part of this push.
Generated native ZIPs, private environment files, credentials and fixture data
are not included.

The session tools remain usable with existing Agents. Confirmed input-only
pause requires a rebuilt compatible Agent; publishing web source alone cannot
add that receiving-side capability to an installed Windows client.

## Verification boundaries

The pre-release workspace browser check used intercepted data and a simulated
peer at desktop and phone sizes. It checked tool switching, contained Fit/1:1
video, local pause/resume, synthetic peer replacement and viewer teardown. It
did not operate a real device or prove Windows input, capture or live transport.

The scoped app-at-root release candidate passed:

- A clean-cache frozen-lockfile install with the production Bun 1.3.6 version.
- TypeScript checking and the selected 116 test entries, including the Access
  console's 51 internal role/action/layout checks.
- The Node-server production web build using synthetic public configuration,
  without application secrets.

The release gate verifies the exact changed-path scope, source hashes and
preservation of all other upstream files before pushing. A stale exported
label assertion was synchronized with the already-tested `End session` label;
no runtime code was changed to satisfy the release checks.

A successful push establishes GitHub delivery, not deployment success. No
manual production deployment, Windows build or installer update is included.
