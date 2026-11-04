# Run the complete Agent source before packaging

This is the **Windows Agent source**, version **1.10.3**. It includes C#,
XAML, project files, branding assets, Watch, the update helper, shared update
code, native tests and build scripts. It is not a binary-download launcher.
No Agent executable or MSI has been built for this source delivery.

## Requirements

- A Windows x64 test machine with the **.NET 8 SDK**, not just the runtime.
- Internet access for NuGet dependency restore and your ConnectLive server.
- A current, unused device-pairing code from your administrator's web console.
  No administrator password, Supabase service key or device token belongs in
  the source or launch command.

## Start from PowerShell

1. Stop any previously extracted/installed Agent. With this source runner use
   `.\run.ps1 -Disable`; older versions may still have a tray menu.
   Do not run the old EXE alongside the source build.
2. Extract the entire source ZIP into a **fresh directory**. Keep its layout:
   `agent`, `tools`, and the included shared test dependency under `admin`.
3. Open PowerShell in the extracted directory:

   ```powershell
   cd .\agent
   Unblock-File .\run.ps1
   .\run.ps1 -Pair
   ```

`run.ps1` builds the Agent, Watch and update helper **locally on your machine**
in Debug configuration, then launches the newly built Agent. It does not
call the installer script, publish a release, sign files, install a service,
or download a prebuilt Agent. Outputs go in a fresh `agent\bin\terminal-*`
folder. Do not move/delete that folder while testing its running processes.

`-Pair` explicitly opens the pairing-code screen even if this Windows user
has saved credentials from an older version. Without `-Pair`, a valid
existing pairing resumes in the background; an unpaired/stopped device still asks
for a code. Background starts never show a pairing dialog.

If your administrator uses another server:

```powershell
.\run.ps1 -Pair -ApiUrl https://your-server.example
```

If Windows policy blocks unsigned local scripts, use your organization's
approved execution-policy/signing procedure; this source does not bypass it.

## What you should see

1. **One ConnectLive pairing-code window**, in the existing blue/navy colors.
   The old status/splash window and separate authorization window are gone.
2. Enter the code and choose **Continue**.
3. Organization, session mode and allowed permissions appear **inside that
   same window**. Choose **Pair and connect** to accept that pairing.
   Invalid/expired codes remain inline errors; no permissions are added by
   the client.
4. The window closes after successful pairing. There is **no status window,
   tray icon/menu, or Stop/Disconnect control UI**. The Agent runs in the
   background under the accepted access policy.
5. The code is the only input. Permissions and session mode come from the
   administrator and are shown read-only. Closing/canceling pairing does not
   authorize access. A stopped device cannot be revived by background startup.

For a second pairing, run `.\run.ps1 -Disable`, obtain a **new** code, then run
with `-Pair` again. Codes are single-use. If the old device record consumes
the last license seat, resolve that record in the administrator console
before creating/redeeming another pairing; the client does not silently
delete existing server records.

An attended pairing can still request approval **when a technician starts a
session**. That is the chosen session policy, not the removed startup dialog.

## Local disable without another UI

In another PowerShell window in the `agent` source folder:

```powershell
.\run.ps1 -Disable
```

This invokes the running Agent's local `/disable` command and waits for it to
exit. It does not build anything or show a control panel. Alternatively run
`ConnectLive.exe /disable` from its installation/output folder, or uninstall.
Withdrawal remains local and works offline.

## Optional startup/recovery testing

Startup is not enabled implicitly by removing its checkbox. A new source
pairing defaults to manual startup. To explicitly request startup/recovery:

```powershell
.\run.ps1 -Pair -StartWithWindows
```

The single pairing screen explains that request inline before **Pair and
connect** records it. No extra checkbox or dialog is shown. Companion apps
must be present; otherwise startup stays disabled. Existing, valid pairings
keep their previously recorded startup policy.

## Agent-only command (no companions)

For a quick UI-only development run:

```powershell
dotnet run --project .\src\ConnectLiveAgent.csproj -- --pair
```

This does not build Watch or the updater; startup/recovery cannot be enabled
if those executables are absent. Prefer `run.ps1` for testing
the complete source. Neither command installs an MSI.

## Later, after your manual verification

`build.ps1` is the **installer/release packaging script**. Do not use it for
the first terminal run. **`-SkipInno` does not skip MSI generation.**
Keep MSI bundling and production signing separate until manual testing is
complete. Signed-update acceptance also requires your publisher's public
verification key and signed test package; this archive includes no private
keys. The run script accepts an optional `-UpdatePublicKeyPath` for that
separate test.

The server must already support the documented pairing/lifecycle protocol.
This Agent source ZIP does **not** deploy the web app or database migrations.
The included server SQL and verification documents are references, not
instructions to run production migrations during this terminal test.

## Verification limits

The source/archive checks do not prove a Windows build, real pairing,
screen streaming, input, clipboard, files, recovery or MSI installation works.
Those Windows runtime checks remain necessary before a production release.
No Windows binary was compiled in the workspace for this delivery.
