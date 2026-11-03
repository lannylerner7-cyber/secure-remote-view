# Browser console and Agent: source audit

## Scope and evidence

This is a source inspection of the repository Agent selected by the user,
the web live-view route, and their update/startup/transport paths. It is not a
Windows runtime, signed-installer, TURN allocation, or fleet-uptime certification.
No remote device commands or updates were sent during this inspection.

The Windows Admin client is not required to open a web viewer. Both clients
use the existing Agent protocol. Removing native Admin source does not remove
a dependency from the browser and is not justified before browser parity.

## Current source corrections — 2026-11-03

The findings below are the historical audit, not a statement that those defects
remain unchanged. Source corrections now include:

- Browser-generated `web-…` identities are accepted by the native video
  signaling parser. The actual browser generator is exercised against that
  parser. This is not a Windows offer/answer or decoded-frame test.
- Modern control/monitor actions retain receipts. Explicit legacy sessions use
  their existing control path and a grant-bound legacy monitor queue, labelled
  **unconfirmed** rather than pretending an acknowledgement exists.
- Updates use an RSA-PSS/SHA-256 signed manifest pinned to a build-time public
  key, exact runtime inventory, bounded staging and HTTPS URL-path parsing.
  No publisher key has been configured; automatic updates remain disabled.
- The updater waits for the original process to exit, journals replacements,
  starts its candidate suspended in a kill-on-worker-exit Windows job, records
  identity before resuming, and requires backend/local-grant health before
  committing. File-copy/health failure restores the previous runtime. Managed
  tests and cross-compilation pass; **Windows execution remains unverified**.
- Watch and Update executables are explicitly published and included in both
  installer definitions. A separate, unchecked startup choice authorizes the
  visible per-user Run entry and non-elevated Watch task. Watch/recovery checks
  local withdrawal and a fresh server grant. No machine-wide automatic startup,
  hidden task, service, power privilege or firewall change was added.
- Automatic updates are restricted to the standard per-user install. The
  per-machine MSI remains administrator-managed. Existing machine-owned
  registration may require IT cleanup; it is not silently elevated away.
- Legacy checksum-only device updaters no longer receive installer payloads
  from stable/beta channels. They require an installer bootstrap. Installer
  downloads and native Admin remain available.

See `imports/connectlive/agent/UPDATING.md` for the release contract and Windows
failure-test matrix. The additive `stable-update` database migration is prepared,
**not applied**, and no runtime bundle was published or sent to a device.

## Original findings (pre-correction baseline)

| Area | What the source actually does | Limitation / risk |
| --- | --- | --- |
| Viewer geometry | Now uses actual source dimensions with bounded fit/1:1 modes and metadata-change handling. | Geometry fixtures pass; actual Windows display changes and DPI still need runtime checks. |
| Self-update scheduling | The Agent checks the published stable release while no session is active, with an hourly check interval and one attempt per version per process. | This is pull-based idle updating, not an immediate push or a live-session hot swap. |
| Update integrity | An SHA-256 manifest value is required and compared with the download. | A checksum is not publisher authentication. This path does not verify an Authenticode publisher or a separately signed release manifest. |
| Update restart | The updater launches the replacement while the old Agent still holds its global single-instance mutex. The caller exits afterward. | There is a possible startup race: the replacement can see the old instance and exit. No successful Windows handoff was observed in this audit. |
| Update rollback | A copy failure attempts to restore the renamed executable. | The launch-failure path does not restore the old image, and there is no post-launch health confirmation. Installed-folder write permissions are also a Windows deployment constraint. |
| Update artifact selection | ZIP detection uses the whole URL's suffix. | A ZIP URL with a query string is not recognized as ZIP. Update manifests and staged packages require validation before rollout. |
| Watch companion | Self-heal only registers the watcher if its executable exists beside the Agent. Watcher startup and relaunch check the local disabled state. | The inspected Agent build script publishes the WPF Agent but does not publish/copy the separate Watch project. A source file existing is not proof the watcher is shipped or running. |
| Startup | Installed-path checks limit registration; development/Downloads runs are skipped. The app has a global single-instance mutex. | Multiple registration mechanisms do not prove successful startup for each Windows user or recovery from all failures. Local disable must remain authoritative. |
| Remote actions | Video-only input now uses the ordered live channel without HTTP polling/duplicate inserts. Mode and monitor acknowledgements are correlated. | Clipboard/files retain their existing protocols; channel send acceptance is not proof of remote application. Real Windows action tests remain. |
| Power-command actions | Viewer reconnect now replaces the browser peer; monitor selection uses a native receipt. Neither writes `power_commands`. | General OS power dispatch remains dormant and was not enabled. View/control must not silently acquire power authority. |
| Curtain feedback | Browser control no longer automatically sends curtain-on. The video-only native protocol rejects curtain-on. Disconnect releases held input and requests legacy curtain cleanup. | No browser privacy or secure-desktop button is advertised. Legacy privacy needs a separate Windows recovery/feedback validation. |
| Fallback | Video-only sessions create no JPEG worker, subscription or input poller; API/database reject image writes. Legacy sessions retain compatibility. | New protocol failures show stalled/disconnected status rather than silently downgrading to JPEG. Actual Windows first-frame reliability remains unverified. |
| TURN | The browser distinguishes ICE configuration from the selected candidate pair. | Receiving relay credentials is not proof that a session allocated or used a relay. Real cross-network media is required to verify TURN. |

## Defensive release requirements

- Keep local stop/revocation effective across startup, watcher and update paths.
  Do not restore access after the user deliberately disabled it.
- Authenticate update publishers, protect release publication, and verify
  staged artifacts before any fleet rollout.
- Require a verified update handoff and recovery test on Windows before
  describing unattended updating as reliable.
- Show separate requested, received, applied, rejected and timed-out states
  wherever acknowledgements exist; do not manufacture applied states.
- Keep ordering within keyboard/mouse and session-transition streams.
  File-transfer traffic and presentation can be separate without allowing
  contradictory state changes to run concurrently.
- Keep native Admin available until explicitly authorized web capabilities
  are tested. No Windows Hello, UAC, secure-desktop or local-recovery bypass
  is part of this work.

## Source locations inspected

- `imports/connectlive/agent/src/App.xaml.cs`
- `imports/connectlive/agent/src/Agent.cs`
- `imports/connectlive/agent/src/SelfUpdate.cs`
- `imports/connectlive/agent/src/StartupRegistration.cs`
- `imports/connectlive/agent/src/StartupSelfHeal.cs`
- `imports/connectlive/agent/src/Watch/Program.cs`
- `imports/connectlive/agent/src/ConnectLiveAgent.csproj`
- `imports/connectlive/agent/build.ps1`
- `imports/connectlive/src/routes/_authenticated/console.tsx`
- `imports/connectlive/src/lib/webrtc-live.ts`
- `imports/connectlive/src/routes/api/public/agent/release.ts`

## Verification boundaries

The presentation changes can be checked with isolated remote-dimension fixtures,
geometry assertions and a web build without operating a real endpoint.
Actual live streaming, watcher recovery, update installation, device actions
and relay connectivity remain unverified by these checks.

The web typecheck exposed a nullable consent timestamp in the reconnect
route. The route now explicitly rejects an active session with no recorded
consent timestamp before the conditional update. This tightens rejection of
invalid state; it does not add a reconnect capability or bypass authorization.
