## Static audit result

The Worker does **not** need administrator privileges. The intended security boundary is already correct:

- `ConnectLiveSetup.exe` is elevated by `PrivilegesRequired=admin`.
- `ConnectLiveWatcher` must run as `LocalSystem` in Session 0.
- `ConnectLive.exe` must run as the signed-in user in the interactive desktop session.
- Giving the interactive Worker admin rights would not fix the installer warning and would weaken the design.

The files are now copied before service registration, so the former `ssInstall` ordering bug is no longer present. The remaining installer path is fragile because it relies on a long `sc.exe create` parameter string, then applies later service operations even if creation failed. Its current logging records only exit codes and does not record the service’s stored image path, state, or Windows startup error. The uploaded Watcher project also contains dependency corrections that are absent from the project copy.

## Implementation plan

1. **Replace fragile service registration with native Windows service APIs in the Inno script**
   - Create/open the Service Control Manager directly from Pascal code.
   - Register `ConnectLiveWatcher` with the exact absolute `ConnectLiveService.exe` path, `LocalSystem`, delayed automatic start, and the existing display name.
   - Eliminate `sc.exe` command-line quoting ambiguity around custom install paths such as `C:\Program Files\ConnectLive\service\ConnectLiveService.exe`.
   - Stop immediately if service creation fails; do not run description, failure-policy, ACL, or start operations against a nonexistent/stale service.

2. **Make stop/delete/reinstall deterministic**
   - Open the existing service with the required rights, stop it, wait for `SERVICE_STOPPED`, delete it, and wait until SCM no longer exposes the old registration.
   - Preserve the current `BeforeInstall` placement so the executable lock is released before file replacement.
   - Keep the service ACL policy: SYSTEM and Administrators control the service; interactive users can query but cannot stop/delete it.

3. **Replace the four-second guess with a real service-state wait**
   - Start the service and poll its state until it reaches `Running`, reports `Stopped`, or reaches a bounded timeout.
   - Capture `dwWin32ExitCode` and `dwServiceSpecificExitCode` when startup fails.
   - Treat `StartPending` as progress rather than immediately reporting failure.

4. **Upgrade installer diagnostics**
   - Log the selected install directory, verified binary path, service account, configured image path, every SCM operation, state transition, and Win32 error message to `%ProgramData%\ConnectLive\install.log`.
   - Preserve the visible warning, but include the exact Windows error code/state instead of only the generic message.
   - Guard log initialization so pre-copy stop/delete operations are recorded too.

5. **Synchronize and harden the Watcher project definition**
   - Apply the uploaded project’s aligned `Microsoft.Extensions.*` versions.
   - Add the explicit `System.Security.Cryptography.ProtectedData` dependency required by the Watcher’s DPAPI calls.
   - Keep `OutputType=WinExe`, `AssemblyName=ConnectLiveService`, self-contained `win-x64`, single-file publishing, and Windows Service hosting.

6. **Sanitize installer behavior without changing the architecture**
   - Check the result of every external/native operation before proceeding.
   - Keep the Agent read-only service probe; it will not start or repair the Watcher.
   - Keep both files in the installer, the selected install folder, firewall rules, service name, LocalSystem identity, and Worker launch-through-`CreateProcessAsUser` unchanged.
   - Avoid granting elevated rights to `ConnectLive.exe`.

7. **Deliverable**
   - Update the project’s `.iss` and Watcher `.csproj` only where required by this diagnosis.
   - Repackage a fresh `ConnectLive-RemoteAgent-src.zip` containing the corrected source installer and Watcher definition.
   - No build or Windows execution will be claimed as validation; the enhanced install log will make the first Windows test conclusive.