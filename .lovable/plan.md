## Verification result

Everything the `.iss` references matches the codebase:

- Service name `ConnectLiveWatcher` — matches `watcher/Program.cs` and `install.ps1`.
- Install dir `{autopf}\ConnectLive` — matches `%ProgramFiles%\ConnectLive` used by `install.ps1`.
- Data dir `{commonappdata}\ConnectLive` and `deployment.key` filename — matches `DeploymentKey.cs` and `watcher/Program.cs:289`.
- Source paths `..\..\dist\ConnectLiveAgent.exe` / `ConnectLiveWatcher.exe` — match `build.bat` output (copies into `agent\dist\`).
- HKLM policy path referenced by `DeploymentKey.cs` (`Software\Policies\ConnectLive\DeploymentKey`) is untouched by the installer, which is correct — GPO/Intune manage that key out-of-band.

## Gaps vs. `install.ps1` / `INSTALL.md` to fix

1. **Watcher isn't stopped before file copy.** `[Run]` executes after `[Files]`, so if the service is running during an upgrade, `ConnectLiveWatcher.exe` is locked and the copy fails. `install.ps1` explicitly stops+deletes the service first. Add a `BeforeInstall` step (or `[InstallDelete]` with `Type: filesandordirs`) that runs `sc stop ConnectLiveWatcher` and waits — `CloseApplications=yes` uses Restart Manager and does not cover a `LocalSystem` service holding the exe.

2. **No service failure/restart policy.** `install.ps1` sets `sc failure ConnectLiveWatcher reset= 60 actions= restart/5000/restart/10000/restart/30000`. Add the same line to `[Run]` right after `sc create`, so a crashed Watcher self-heals the same way as the PowerShell install.

3. **DisplayName missing on `sc create`.** `install.ps1` uses `DisplayName= "ConnectLive Watcher"` and a human description; the `.iss` sets only the description. Add `DisplayName= "ConnectLive Watcher"` for parity in `services.msc`.

4. **ProgramData ACL doesn't grant INTERACTIVE read.** `install.ps1` explicitly grants `NT AUTHORITY\INTERACTIVE : ReadAndExecute` because the Agent runs as the logged-in user and calls `DeploymentKey.Resolve()`, which reads `%ProgramData%\ConnectLive\deployment.key`. The `.iss` `Permissions: owners-full admins-full system-full` adds those ACEs but relies on default ProgramData inheritance for user read — which is fragile. Add `users-readexec` (or an explicit ACE via a `[Code]` step) so a non-admin interactive Agent can always read the key.

5. **Watcher spawns Agent from `%ProgramData%\ConnectLive\ConnectLiveAgent.exe`, not `%ProgramFiles%`.** `watcher/Program.cs:66` builds the worker path as `Path.Combine(CommonApplicationData, "ConnectLive", "ConnectLiveAgent.exe")` and only falls back to `AppContext.BaseDirectory` (line 250). `install.ps1` sidesteps this by relying on the fallback since both live in `%ProgramFiles%`. The `.iss` also relies on the fallback, which is fine — but call it out in the README so future refactors don't move the Watcher exe without also updating the primary lookup path (or shipping a copy into ProgramData).

6. **Uninstall order.** `[UninstallRun]` stops the service, then kills the Agent, then deletes the service. If the service auto-restarts before delete, the delete becomes "marked for deletion" until reboot. Reorder to: stop → delete → taskkill Agent → firewall cleanup, and add a small `timeout /t 2` between stop and delete (or use `sc.exe` with `Flags: waituntilterminated`).

7. **Docs pointer.** The `.iss` header comment says to run `iscc agent\packaging\inno\ConnectLiveSetup.iss`, but doesn't note the `build.bat` prerequisite. `README.md` already covers it — add a one-line reminder in the `.iss` header so someone opening only the script sees it.

## Non-issues (intentionally left alone)

- `start= delayed-auto` (Inno) vs `start= auto` (install.ps1): `INSTALL.md` explicitly specifies `DelayedAutostart=1` — the `.iss` is the correct one.
- Uninstall keeps `%ProgramData%\ConnectLive`: matches `install.ps1` behavior so device tokens survive reinstall.
- Watcher `.csproj` has no elevation manifest: correct — it runs under `LocalSystem`.

## Deliverables

- Edit `agent/packaging/inno/ConnectLiveSetup.iss` applying items 1–4, 6, 7.
- Update `agent/packaging/inno/README.md` with item 5's callout and a note that upgrades stop the service automatically.

No changes to any C#, MSI, GPO, Intune, or Jamf packaging.
