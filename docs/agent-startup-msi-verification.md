# Windows Agent startup and MSI verification

Date: 2026-11-15. Source review and isolated execution, not a Windows release.

## Findings and changes

- Recognized registered custom MSI paths and per-user/custom Inno locations,
  not only the default Program Files location. Development copies remain
  excluded from installed startup registration.
- Added an explicit local **enable Windows startup** action and installer Start
  menu shortcut. It works for an already-paired running Agent; ordinary install
  and pairing do not silently authorize persistence. It uses the existing
  cross-process owner-setup input/media barrier and rechecks local authority
  after confirmation.
- Added an explicit paired-user logon trigger to the existing visible,
  limited-user Watch task. Kept battery support, singleton behavior,
  one-minute recovery, no wake-from-sleep and unlimited task execution time.
- Logged registration success/failure and actual Agent exit without claiming
  a utility/secondary process exit is the running Agent closing.
- Added a machine-uninstall receipt bound to the install directory and stored
  outside installer-owned registry values. Offline profiles cannot silently
  reuse their old grant after reinstall. Major upgrades do not create this
  receipt. Rollback deliberately does not restore withdrawn permission.
- Forgot session-tool consent on the normal local-disable path as well as the
  command-line withdrawal path.
- Strengthened MSI build verification: exact three-runtime inventory,
  versions/sizes, x64 components, per-machine scope, explicit startup shortcut,
  upgrade-safe removal actions, real ProductCode and COM handle release before
  signing. Missing signing helper now fails instead of silently skipping it.
- Added `Verify-Startup.ps1`, a read-only local readiness report. It never reads
  device tokens/PIN files, contacts the server, launches/kills software or
  enables settings.
- Replaced outdated installer directions describing keyless enrollment, four
  forced startup triggers, elevation at each login and timestamp MSI versions.

## Evidence

| Check | Result / boundary |
| --- | --- |
| Portable startup harness | 30 policy assertions; compiled actual startup, setup, grant-store and installation-lifecycle source with inert UI/elevation adapters. No Windows registry/DPAPI/task execution. |
| PowerShell harness | 32 parser/MSI-validator checks using synthetic MSI tables. No MSI compilation, COM database opening or signing. |
| Installer contracts | XML/source inventory, startup and withdrawal/upgrade conditions passed. |
| Lifecycle display/receipts | 22 existing isolated lifecycle/browser receipt assertions passed. |
| Isolated PostgreSQL | 21 pairing/authorization checks plus 26 lifecycle checks passed; actual authorization, RLS and lifecycle functions, rollback-only. No remote database. |
| Route outage/identity suite | 69 assertions passed after updating outdated fixtures for current permission/file routes and unavailable-vs-denied responses. Production routes were not modified. |
| Native gateway/lifecycle/update model | 25 lifecycle + 22 gateway + 15 peer + 46 update assertions passed. Added missing real input-pause dependency to the older portable project. |
| Native pairing/HTTP model | 765 assertions passed; added the same missing source reference, no Windows binaries. |
| Previously merged session tools | 15 Node tests and 42 portable C# assertions passed. UI adapter warnings are not Windows runtime evidence. |
| Pairing UI source contracts | Passed, including no tray/status window and local withdrawal. |

These passing checks do **not** certify the entire native application's Windows
build. The portable harness compiles only its explicitly linked production files.

## What the lifecycle information means

- Closing/killing a process is not revocation. With prior local opt-in, Watch
  can request bounded recovery after checking current server authorization.
- Only a matching fresh Agent heartbeat confirms health; Watch cannot invent
  one. A stale heartbeat or loss of both processes is offline/unknown, not
  evidence that software was removed.
- Admin access revocation is a server action recorded as
  `device.access_revoked`. A device may still have a resident process or
  authenticated presence after its **remote-access grant** is withdrawn.
  That must not be confused with allowed screen/input/file/microphone access.
- An offline endpoint cannot acknowledge a revoke immediately. Server access
  is denied; local channels close through their existing permission/lease
  checks. No hard guarantee of instantaneous cleanup was measured here.
- Confirmed local disable/removal is durable. A network error or ambiguous
  HTTP rejection is never treated as permission to delete pairing or silently
  register a different identity.

## Still requires Windows

Use `imports/connectlive/agent/INSTALL.md` for the manual source-first build,
MSI build and before/after reboot commands. Mandatory Windows evidence:

1. Full source build with real WPF/WinForms and native dependencies.
2. WiX compilation and actual MSI database/signature inspection.
3. Standard-user pairing, startup approval, Task Manager and Task Scheduler.
4. Reboot/logon, delayed networking, process crash recovery and moving video.
5. Admin revoke/delete and local `/disable` with every live tool stopped.
6. Upgrade, repair, failed-install rollback, uninstall/reinstall and an offline
   second-user profile. The removal action executes the installed Agent under
   installer elevation; verify silent Windows Installer execution and ACLs.
7. Signed-out profiles may retain inactive Run/task references until that
   user's cleanup or an IT-managed cleanup. This work does not force-load or
   delete other users' private hives.

No Windows binary, MSI, release ZIP or source archive was produced here. No
GitHub push, production deployment, shared database migration or customer-device
operation was performed. The source version is unchanged pending release.
