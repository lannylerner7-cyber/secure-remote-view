## Goal

Rewrite `agent/packaging/inno/ConnectLiveSetup.iss` so a single `ConnectLiveSetup.exe`:
- Lets end users pick the install folder (standard Inno wizard page).
- Bundles both `ConnectLiveAgent.exe` and `ConnectLiveWatcher.exe` inside one installer.
- Registers the Watcher as a hardened Windows service that resists accidental deletion from Control Panel / Programs list.
- Contains no `deployment.key` handling anywhere (matches current keyless auto-enroll architecture).

## Changes to `agent/packaging/inno/ConnectLiveSetup.iss`

1. **[Setup] section**
   - Bump `AppVersion` to `5.0`.
   - Keep `DefaultDirName={autopf}\ConnectLive` but REMOVE `DisableDirPage` (never set in current file — confirm it stays absent) so the "Select Destination Location" wizard page shows.
   - Add `DisableDirPage=no` explicitly for clarity.
   - Add `AppId={{B4E9A1C2-7F3D-4A6E-9C2B-ConnectLive5000}}` so upgrades track the same install regardless of chosen folder.
   - Keep `PrivilegesRequired=admin`, `ArchitecturesInstallIn64BitMode=x64`, `CloseApplications=yes`.

2. **[Dirs] section**
   - Keep `{commonappdata}\ConnectLive` with locked-down ACL (SYSTEM/Admins full, Users read-exec) — this is where DPAPI `device.dat` lives; it must not depend on the user-chosen install folder.

3. **[Files] section**
   - Ship both binaries from `..\..\dist\` into `{app}` (user-selected folder):
     - `ConnectLiveAgent.exe`
     - `ConnectLiveWatcher.exe` (with `BeforeInstall: StopWatcherService`)
   - Both flagged `ignoreversion`.

4. **[Run] — service registration hardened against accidental deletion**
   - Stop + delete any existing `ConnectLiveWatcher` service (upgrade path).
   - `sc create ConnectLiveWatcher binPath= "{app}\ConnectLiveWatcher.exe" start= auto obj= LocalSystem DisplayName= "ConnectLive Watcher"`.
   - `sc description ...` explaining its role.
   - `sc failure ConnectLiveWatcher reset= 60 actions= restart/5000/restart/10000/restart/30000` (self-heal).
   - **NEW — deletion protection:** apply a restrictive SDDL so non-SYSTEM users cannot stop/delete the service from `services.msc` or `sc delete`:
     `sc sdset ConnectLiveWatcher "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCLCSWRPWPDTLOCRRC;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"` — grants only SYSTEM and Administrators full control; interactive users get read-only. Prevents "mistake deletion in panel".
   - Firewall rules for both `ConnectLiveAgent.exe` and `ConnectLiveWatcher.exe` (unchanged).
   - Start `ConnectLiveWatcher` immediately post-install.

5. **[UninstallRun]**
   - Before delete, first `sc sdset ConnectLiveWatcher D:(A;;GA;;;SY)(A;;GA;;;BA)` to restore write access so the uninstall can actually remove the service.
   - Then existing stop / delete / taskkill / firewall cleanup.

6. **[Code] section — cleaned**
   - Keep `ServiceExists()` helper.
   - Keep `StopWatcherService()` (called via `BeforeInstall`).
   - **Remove entirely** the `CurStepChanged` procedure that wrote `deployment.key`, and any references to `DEPLOYMENT_KEY`, `LocalSidecarKey`, or `deployment.key` sidecar file. No more key provisioning path — the Watcher auto-enrolls on first boot via `/api/public/agent/enroll`.

## Also update

- `agent/packaging/inno/README.md` — if it still mentions selecting a folder being disabled or references any deployment key, sync wording to "user-selectable install folder, no key required, single installer bundles agent + watcher".

## Out of scope

- No changes to agent/watcher C# code, server routes, or admin console.
- No re-zipping of source bundles this turn (installer is a build-artifact concern; user asked only for the `.iss` rewrite).

## Technical notes

- `AppId` with a fixed GUID is required so users choosing different folders across upgrades still get an in-place upgrade instead of a parallel install.
- The SDDL string above is the standard Windows service ACL minus the `WD` (Everyone) and `AU` (Authenticated Users) delete/stop rights — this is the same technique EDR products use to prevent tampering. Local Admins can still remove it via the uninstaller (which restores the ACL first).
- Silent install remains `ConnectLiveSetup.exe /VERYSILENT` and now also `/DIR="C:\Custom\Path"` for enterprises overriding the default folder.
