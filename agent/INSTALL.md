# ConnectLive Agent — Windows build, startup and removal

## What is installed

| File | Purpose |
| --- | --- |
| `ConnectLive.exe` | Interactive-user Agent: pairing, authorized sessions, capture and input |
| `ConnectLiveWatch.exe` | Separately opted-in recovery and process observations |
| `ConnectLiveUpdate.exe` | Signed update worker; never elevates itself |

The Agent uses `asInvoker`. Normal startup does not request administrator rights.
There is no installer-created capture service, SYSTEM task, keyless enrollment,
or automatic permission grant. The optional Windows-unlock service has its own
explicit setup and is **not** included in this MSI.

**Startup means after the paired Windows user signs in following a reboot.**
It does not mean remote capture before sign-in, unlocking the computer,
waking a powered-off computer, or surviving removal/revocation.

## 1. Test the source before packaging

Use an authorized Windows x64 test PC with the .NET 8 SDK:

```powershell
cd .\agent
.\run.ps1 -Pair
```

This builds the Agent and both companions on **your Windows machine**, not an
installer. Use the administrator's pairing code in the local Agent window.
Test the existing video, curtain and session tools before proceeding.

Source/development directories do not register installed startup entries.
`run.ps1 -StartWithWindows` can record the disclosed choice, but does not make a
temporary `bin\terminal-*` folder into an installation. Do not use that flag as
evidence of reboot persistence.

## 2. Build the MSI after source acceptance

Run the build manually in 64-bit Windows PowerShell:

```powershell
# MSI only; default version comes from src\ConnectLiveAgent.csproj.
.\build.ps1 -SkipInno

# Equivalent wrapper; accepts signing/update options too.
.\packaging\msi\build-msi.ps1

# Both MSI and Inno, if Inno Setup 6 is on PATH.
.\build.ps1
```

The `.NET 8 SDK` is required. WiX **4.0.6** and its pinned Util/Firewall
extensions are restored from the included `.config\dotnet-tools.json`; do not
substitute a global, unpinned WiX version. Versions use **three** numeric fields,
bounded to `255.255.65535`, not a timestamp or four-field ProductVersion.

`-SkipMsi` builds Inno only. `-SkipInno` **still builds an MSI**.
`build-developer.ps1` publishes only the raw Agent; it is not a complete
startup/recovery install because it does not package the companions.

Signing uses the existing `CODESIGN_*` configuration, described in
`../docs/SIGNING.md`. Never paste keys or signing passwords into chat.
Missing signing configuration produces an explicitly unsigned test build;
configured signing errors or a missing signing helper stop the build.
`-SkipSign` is only for local testing, not public distribution.

Automatic runtime updates remain disabled without a reviewed publisher public
key. `-UpdatePublicKeyPath` and `-CreateUpdateBundle` are separate from building
an MSI. Program Files updates remain administrator-managed.

### What the build verifies

- Fresh publish outputs for **all three** runtime executables.
- Requested version and matching payload versions/sizes in the compiled MSI.
- x64, per-machine packaging; no installer-created autorun/capture service.
- Explicit owner startup shortcut.
- Removal receipt and local-withdrawal actions in the correct sequence.
- Removal actions excluded during a major upgrade.
- Real MSI ProductCode used for Intune metadata, not its UpgradeCode.
- MSI database handles released before signing.
- Only this run's selected installers included in the distribution ZIP.

Outputs include:

```text
dist\ConnectLiveAgent.msi
dist\Intune-app.json
dist\MSI-VERIFICATION.json
dist\Verify-Startup.ps1
dist\ConnectLiveAgent.zip
```

`MSI-VERIFICATION.json` records the signed/unsigned MSI's final SHA-256,
signature status and table checks. It explicitly says installation and reboot
have **not** been certified by those checks.

## 3. Install and authorize startup

Install the MSI with normal Windows administrator approval. For an IT-managed
silent installation, run from an elevated terminal:

```powershell
msiexec.exe /i ".\dist\ConnectLiveAgent.msi" /qn /norestart /L*v "$env:TEMP\ConnectLive-install.log"
```

A silent install copies software only. The intended Windows user must sign in,
open **ConnectLive**, and complete the local pairing.

Then choose **ConnectLive - enable Windows startup** in the Start menu, or run:

```powershell
& "$env:ProgramFiles\ConnectLive\ConnectLive.exe" --startup-enable
```

Use the actual install path for a custom or per-user Inno installation.
Confirm the local startup/recovery disclosure. This works while the paired
Agent is already running and does not require another pairing code. ConnectLive
remote input/media is paused around this local approval; the technician must
not approve persistence on the owner's behalf. Turn off the curtain before
local setup so the owner can use the keyboard/mouse.

For a new pairing, the existing `--start-with-windows` flag can combine the
startup disclosure with pairing. An ordinary pairing alone does not opt in.

Authorized startup consists of:

1. **HKCU Run / Task Manager Startup apps**: `ConnectLive.exe /background`.
2. **Visible per-user scheduled task** `ConnectLiveWatch-<Windows SID>`:
   a user-specific logon trigger plus one-minute recovery trigger,
   `InteractiveToken`, `LeastPrivilege`, `IgnoreNew`, no wake-from-sleep and
   no default three-day task timeout.

Watch and Agent have singleton guards. Windows policy/registration failures are
logged and reported rather than falling back to an elevated or hidden task.
Custom MSI and Inno install locations are recognized; source/test copies must
not overwrite the installed startup path.

## 4. Verify locally before and after reboot

Run as the **same Windows user who paired**, not SYSTEM or another administrator:

```powershell
.\dist\Verify-Startup.ps1 -OutputPath ".\startup-before.json" -RequireReady
# Reboot the test PC yourself, sign back into that Windows account, then:
.\dist\Verify-Startup.ps1 -OutputPath ".\startup-after.json" -RequireReady
```

For a custom location add `-InstallDirectory "C:\Apps\ConnectLive"`.
For version-specific acceptance add `-ExpectedVersion "1.10.14"` (replace with
the version you actually built).

The script is read-only except for the requested report. It checks runtime
files/versions, protected startup policy, uninstall/disable/session-end markers,
Run entry, task configuration, process identities and recent local heartbeat
receipt. It does **not** contact the backend, reveal tokens/PINs, change registry
settings, start/kill processes, or claim it performed the reboot.

Task Manager should show one installed Agent and one Watch in this Windows
session. The updater is not an always-running process.

## 5. Closed, offline, revoked and removed are different

| Observation/action | Expected behavior |
| --- | --- |
| Agent crashes or is ended in Task Manager | Opted-in Watch observes the missing matching process; bounded recovery requires a fresh server authorization check. Killing the process is not revoking permission. |
| Watch reports `stopped` | Admin can distinguish a stopped process from an unknown/offline endpoint while Watch's report is fresh. |
| Both processes stop, no network, or PC powers off | Heartbeat ages to reconnecting/offline. This is **not** proof of uninstall or revocation. |
| Admin **Revoke device access** succeeds | Server records `device.access_revoked` and withdraws session authority. Old local approval cannot authorize a Watch relaunch. A resident process/check-in is not evidence of remote permission. |
| Admin revokes an unused pairing code | Only that code is revoked; an already-paired device is unaffected. |
| Device record is deleted | Its credentials no longer authenticate. No automatic enrollment under another device identity. |
| `ConnectLive.exe /disable` | Live access stops, a durable local withdrawal is saved, local unlock/tools consent is forgotten and per-user startup entries are removed. Network reporting is best effort. |
| Confirmed support-session end | A new pairing code is required, including after process restart. |
| MSI uninstall | Machine-wide removal receipt invalidates old local approvals, including signed-out profiles; active processes also observe the removal. |
| Failed/rolled-back uninstall | Binary restoration must not restore withdrawn approval. Explicit local pairing can be required again. |

Disabling just the Run entry in Task Manager is **not** the supported way to
withdraw the separately approved Watch recovery policy. Use `/disable` or normal
uninstall to stop both. No process is protected from Task Manager.

Logs are under `%LOCALAPPDATA%\ConnectLive\`:
`agent-YYYYMMDD.log`, `watch.log`, and a non-secret process/heartbeat snapshot.
A force-kill/power loss cannot emit a final Agent exit event; use Watch and
last-seen evidence, not an invented shutdown reason.

## 6. Windows acceptance checklist — do not skip

On an approved test device, keep a person at its keyboard:

- Fresh MSI install, first pairing, explicit startup enable; no extra UI/tray.
- Reboot and sign into the paired account; compare both startup reports and
  verify fresh Admin check-in plus actual moving video.
- Standard-user login, battery power, a custom install path, and delayed network.
- End only the Agent; confirm bounded, authorized recovery with a new process
  and fresh heartbeat. End Watch separately; confirm its task can restart it.
- `/disable`, then reboot; neither old grant nor recovery may restore access.
- Admin revoke/delete; old permission and stale commands must never reopen
  video, input, files, microphone or unlock.
- Supported upgrade and repair; no surprise consent change, duplicate process
  or stale executable. Test installer rollback separately.
- Uninstall while another paired user is signed out, reinstall the **same**
  MSI, then sign into that user: old approval must not resume.
- Inspect/remove orphaned Run/task references in signed-out profiles through
  your normal IT process. No logged-out user's private hive is force-loaded by
  this installer. An absent executable or invalid grant never permits relaunch.
- Check normal Apps & Features removal. Do not use `Win32_Product` for
  detection: it can trigger Windows Installer consistency checks.

Only real Windows results establish MSI compilation/installation, ACL behavior,
rollback, task creation, reboot recovery and hardware video. Linux parsing,
portable C# tests, mock MSI tables and isolated database tests do not.
