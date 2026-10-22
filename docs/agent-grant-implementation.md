# Windows agent recorded authorization (inactive source)

## Scope

Changes are confined to `imports/connectlive/agent`, portable tests in
`tests/agent-grants`, and this document. No server, SQL, admin, running artifact,
release ZIP, deployment, service activation, or roadmap/task state is changed
by this implementation.

The existing ConnectLive status window and lifecycle remain. A foreground
launch presents an informed authorization dialog with no preselected mode or
capabilities. The status window also offers **Review / replace authorization**;
opening a minimized background instance and clicking this button is an explicit
foreground action. This is important because the existing single-instance
lifecycle does not transfer focus/arguments from a second launch.

The dialog explains attended/unattended operation and view, control, clipboard,
files, recording, local withdrawal, and replacement. Control requires view.
The device submits notice version 1 and exactly the selected independent scopes
to the contract authorization endpoint. The returned record must parse strictly
and match those choices and the device identity used for the agreement.
Only then is a matching grant saved with Windows DPAPI **CurrentUser** in the
per-user local application-data store. Save failure does not activate the grant.
No legacy credentials, Meeting ID, license, standing consent, timestamps, remote
grant alone, or saved session binding can manufacture local authorization.
Background/wake/watchdog starts do not display or automatically accept a grant.

Each successful heartbeat must carry a valid, unrevoked, version-1 authorization
matching the saved origin, device, ID, mode, scopes, and recorded time.
Missing/malformed authority, scope or identity mismatch, replacement, network
heartbeat failure, or authorization rejection closes live authority.
Presence may continue without capture. Remote power commands are not dispatched
by this defensive coordinator because this contract defines no power scope.

Invited attended sessions require local Yes/No acceptance (default No) before
the consent POST containing authorization ID and notice version. Dialog results
are checked against current authority, cancellation, invitation state and epoch.
Unattended invites use the explicit saved grant without recurring prompts.
An already-active unattended row may resume only under matching local grant and
fresh heartbeat authority; the server must enforce its stored authorizing ID.
An attended session after process restart is deliberately dormant until a fresh
invite, rather than treating an old active row/disk binding as acceptance.

## Live channel enforcement

- Capture/cursor loops retain the session's revocable permission and cancellation
  token; capture entry/iterations and frame/cursor HTTP uploads require view.
- Peer frame encoding **and encoded-frame send callbacks** require view.
- HTTP queued input and peer input both reach guarded native application.
  Queued work keeps its original permission. Native injection rechecks permission,
  bounded key/text sequences recheck while running, and cleanup releases remotely
  held keys/buttons as well as the blocking-input/privacy curtain state.
- Clipboard checks its captured permission again inside UI callbacks for both
  read and write. File receive/reassembly/write and send/read/chunk pathways,
  including HTTP fallback, require files. Partial inbound staging files are
  removed when authorization is lost. File IO cancellation links to the original
  permission lifetime.
- Pause/end/replacement/local disable revoke the old permission permanently,
  cancel loops/transfers, release input and close the peer. New instances cannot
  revive old queued callbacks. Mode changes replace the live pipeline.
- Foreground review suspends live authority while its dialog/POST is pending.
  A saved replacement still needs fresh matching heartbeat authority.
- Local Disable/Close stops live work **before** disk persistence or network
  revocation. The durable disabled marker survives restart/watchdog; only a
  successful explicit foreground authorization can clear it. Server revocation
  is best effort with a separate three-second timeout, never a prerequisite for
  stopping. Marker-save errors are explicitly shown.
- Permission locks are not held across native/UI callbacks or cancellation
  callbacks. Input curtain dispatch is asynchronous and rechecks authority
  before showing. Signaling primitives are not disposed under pending async work.
  A session/authorization 401 is not silently retried under a re-enrolled identity.

## Verification and limits

The .NET 8 Windows-targeted agent cross-build succeeds with:

```
dotnet build imports/connectlive/agent/src/ConnectLiveAgent.csproj -p:EnableWindowsTargeting=true --no-self-contained --artifacts-path /tmp/connectlive-agent-build -o /tmp/connectlive-agent-build/out
```

Portable tests compile the actual pure grant, permission, and local-disable
source into a `net8.0` console runner, without Windows/WPF dependencies:

```
dotnet build tests/agent-grants/AgentGrants.csproj --artifacts-path /tmp/connectlive-agent-grant-tests
dotnet /tmp/connectlive-agent-grant-tests/bin/AgentGrants/debug/AgentGrants.dll
```

They cover strict grant shape/version/revocation, origin/device/ID/mode/scope
matching, scope independence, unknown scope denial, view-only input denial,
permanent closed-session guards, old/new epoch isolation, cancellation lock
safety, and persisted local-disable markers.
The portable runner passes 54 assertions, including offline-to-online startup,
shutdown/withdrawal during enrollment retry and non-retryable identity rejection.
Startup enrollment now uses a cancellable asynchronous retry helper before the
foreground agreement; retries do not create grants. The Windows cross-build has no
errors; warnings concern two pre-existing async-without-await dispatcher
methods and the existing Windows Forms high-DPI manifest setting.

**No Windows runtime is available.** WPF dialog rendering, modal lifecycle,
DPAPI/Windows-account isolation, actual native capture/input/held-key cleanup,
clipboard, DXGI/encoders, peer shutdown races and file transfer were not executed
or visually verified. Cross-build and portable guards are not full native
verification. No real agreement/grant or consent evidence was generated.
The tests do not constitute server/API/peer end-to-end integration tests.

Already-admitted bounded native or disk operations may finish during withdrawal;
subsequent work and sends must pass the revoked guard. Windows runtime stress
testing is still required for cancellation and native resource teardown.
Recording is an independently recorded capability for server/admin enforcement:
this agent has no native recording entrypoint and cannot technically prevent a
viewer or external application from recording an otherwise authorized screen.
Attended dialogs cannot be programmatically dismissed by the generic dispatcher;
late results are rejected, but a stale dialog can remain visible until dismissed.
If Windows refuses the disabled-marker write, future restart prevention cannot
be guaranteed; the existing explicit uninstall warning remains.
