# Persistent status and local withdrawal

## Peer input permission follow-up

The Agent now gives each WebRTC peer a revocable input permission object.
View/unknown modes reject direct peer control; observed mode changes update the
guard even while session loops remain healthy. Pause, end, peer close and session
replacement revoke the old object permanently, so a newer session cannot grant
permission to callbacks retaining an old one.

Input callbacks no longer buffer mouse moves across permission changes.
Each application is guarded independently. The guard does not hold its lock
during native/UI execution to avoid deadlocking local withdrawal; an already
admitted native operation can finish. This is not a proven hard real-time stop.

The isolated C# suite now passes **14 checks**: seven withdrawal-storage tests
and seven permission tests (view, unknown mode, control, downgrade, revocation,
replacement independence and stale callback rejection).

This guards **peer input**, not all channels. HTTP input, capture, clipboard,
files, enrollment grants and recorded server authorization still require
complete integrated enforcement. Server mode alone is not informed consent.
Full Windows compilation/runtime verification remains incomplete. No runtime
or production service was started.

## Implemented in inactive staged source

- The Agent status window no longer auto-closes after five seconds.
- Background launches retain a minimized taskbar surface. Session status is
  reflected in the window title without stealing focus on every wake.
- Closing the window or choosing **Disable remote access** requests withdrawal.
- A per-Windows-user marker is written before stopping. Startup checks it before
  network activity, enrollment, stored-session recovery and startup self-heal.
- The marker survives agent restarts; no code added here deletes it or provides
  a silent reenable path. Explicit reauthorization remains unimplemented.
- The Agent coordinator rejects subsequent local session-start requests once
  stopped. Shutdown cancels the outer loop and requests session teardown.
- The repository Watch helper checks the same marker before credentials are
  read, before a new beacon, and before attempting relaunch.
- If persistence fails, the UI explicitly says it could not save withdrawal and
  advises uninstall; it does not claim that future starts are blocked.

## Verification

The actual storage implementation was compiled and executed in an isolated
.NET 8 test harness, without running Agent/Watch or contacting a service.

`dotnet run --project tests/local-access-state/LocalAccessState.Tests.csproj`

Seven checks passed: missing marker, persisted withdrawal, repeated withdrawal,
empty marker, corrupt marker, unreadable marker, and reported write failure.
These are storage tests, not Windows end-to-end tests.

Full Agent cross-compilation was attempted. It failed on duplicate assembly
attributes from nested Watch generated files. A diagnostic command-line exclusion
of that nested project progressed to an existing missing KeyNotFoundException
namespace reference in InputRelay. No successful full build or release package
was produced. The project configuration was not changed to hide these failures.

NuGet also reported high-severity advisories for pinned SIPSorcery 10.0.13:
- https://github.com/advisories/GHSA-jwjp-4649-v8jp
- https://github.com/advisories/GHSA-pfvm-w89x-94jw

Dependencies were not upgraded as part of this narrowly defensive change.
Their exposure and a supported patched version require review before release.

## Remaining limitations

- Windows UI, minimize/restore, close/disable, session teardown and Watch
  interactions have not been executed.
- The marker affects the current Windows profile, not other enrolled profiles.
- An already in-flight request may complete; checks do not retroactively cancel
  Watch's HTTP request or prove that all peer callbacks have quiesced.
- Privileged/local-user removal of the marker is not prevented. It is a durable
  local preference, not tamper-resistant server authorization.
- Recorded enrollment grants, server revocation and per-channel permissions
  remain incomplete. These controls cannot substitute for that work.
- Task #1 and operational import remain incomplete. No credentials, endpoints,
  signing configuration or production deployment were activated.
