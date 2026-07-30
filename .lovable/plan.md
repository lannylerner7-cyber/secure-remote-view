## Confirmed diagnosis

- `agent/src/App.xaml.cs` (`EnsureWatcherRunning`) both calls `service.Start()` and, on failure, elevates `install.ps1` — this is the code the brief flags. When the Agent is launched by the user it runs as the user; anything it starts inherits the user token, so `WTSQueryUserToken` inside the Watcher fails with access denied and `CreateProcessAsUser` never succeeds.
- The Watcher must only ever be started by Windows SCM as LocalSystem (via the installer). The Agent must only observe status and refuse to run if the service is not present/Running.
- `agent/watcher/ConnectLiveWatcher.csproj` still emits `ConnectLiveWatcher.exe`; the brief renames the binary to `ConnectLiveService.exe` while keeping the internal Windows service name `ConnectLiveWatcher`.
- `agent/watcher/Program.cs` `InstalledAgentPath` is already correct; only a third fallback (one level up from the service subfolder) needs to be added to `ResolveAgentPath`.
- `agent/build.ps1` copies `publish/watcher/ConnectLiveWatcher.exe` and must switch to `ConnectLiveService.exe`.
- The SSE endpoint `src/routes/api/public/agent/stream.ts` already exists, so instant wake via SSE is not part of this brief's scope.

## Implementation plan

1. **Agent stops touching the Watcher (critical fix)**
  - Remove all Watcher start/repair logic from `agent/src/App.xaml.cs`: no `service.Start()`, no `WaitForStatus`, no `install.ps1` elevation, no `Process.Start` targeting the Watcher.
  - Replace `EnsureWatcherRunning()` with a read-only `IsWatcherServiceRunning()` check using `ServiceController("ConnectLiveWatcher").Status == Running`.
  - On startup, if the service is not Running, show exactly the message from the brief ("ConnectLive background service is not running. Please reinstall ConnectLive or contact your administrator.") and shut the Agent down. Do not attempt any repair.
  - Audit `agent/src` for any other spawn of `ConnectLiveWatcher.exe` / `ConnectLiveService.exe` / `sc.exe start` / `install.ps1` and remove them. `PowerRelay.cs` `Process.Start` is a shutdown/reboot call and stays.
2. **Rename the Watcher binary to `ConnectLiveService.exe**`
  - In `agent/watcher/ConnectLiveWatcher.csproj`, change `<AssemblyName>ConnectLiveWatcher</AssemblyName>` to `<AssemblyName>ConnectLiveService</AssemblyName>`.
  - Leave `builder.Services.AddWindowsService(o => o.ServiceName = "ConnectLiveWatcher");` in `agent/watcher/Program.cs` untouched so the SCM identity and installer sc.exe calls remain valid.
  - Keep the C# project folder/name unchanged; only the compiled output filename changes.
3. **Watcher agent-path resolution — add third fallback**
  - In `agent/watcher/Program.cs` `ResolveAgentPath()`, keep the existing `InstalledAgentPath` (Program Files\ConnectLive\ConnectLive.exe) and beside-service fallback, and add a third fallback: `Path.Combine(Path.GetDirectoryName(AppContext.BaseDirectory) ?? "", "ConnectLive.exe")`.
4. **Build script + packaging follow the renamed binary**
  - `agent/build.ps1`: change the copy line to `Copy-Item publish/watcher/ConnectLiveService.exe dist/ -Force` and update the archive `Compress-Archive` and console output to reference `ConnectLiveService.exe`.
  - `build.bat`: update the copy, existence checks, and `Compress-Archive` list from `ConnectLiveWatcher.exe` to `ConnectLiveService.exe`.
  - `agent/install.ps1`: switch source binary lookup, `Copy-Item`, and the `sc.exe create ... binPath=` argument to `ConnectLiveService.exe`; keep the service name `ConnectLiveWatcher` and its SDDL/failure/description hardening exactly as-is. Update the uninstaller `Get-Process` guard.
  - `agent/packaging/inno/ConnectLiveSetup.iss`: rename the `[Files]` source and `binPath=` for the service, plus the firewall rule `program=` argument for the Watcher, to `ConnectLiveService.exe`. Keep the service name, SDDL, failure policy, and `[UninstallRun]` steps unchanged.
5. **Docs and operator guidance**
  - Update `agent/INSTALL.md` and `agent/packaging/inno/README.md` to reference `ConnectLiveService.exe` for the service binary while keeping the service identifier `ConnectLiveWatcher`.
  - Emphasize that `ConnectLive.exe` never installs, starts, or repairs the service — the installer owns that responsibility.
6. **Verification**
  - Search the repo for any remaining references to `ConnectLiveWatcher.exe` and confirm each is either historical documentation clearly labeled as such or intentionally left as the internal service name (not a filename).
  - Confirm the Agent has no code path that starts the Watcher, and its only Watcher interaction is a `ServiceController` status read plus the "reinstall" message when the service is not Running.
  - SSE `/api/public/agent/stream` remains as-is; no backend changes are part of this brief.
7. Two small gaps the plan doesn't mention
  **Gap 1 — `watcher-health.json` missing from `[UninstallDelete]**`
  The plan says `[UninstallRun] steps unchanged` but the Watcher writes `watcher-health.json` to `%ProgramData%\ConnectLive\` at runtime. Add this to `[UninstallDelete]` in the `.iss`:
  ini
  ```ini
  Type: files; Name: "{commonappdata}\ConnectLive\watcher-health.json"
  ```
  **Gap 2 — `install.ps1` role needs clarifying in docs**
  The plan updates `install.ps1` to use `ConnectLiveService.exe` which is correct. But the docs update should explicitly state `install.ps1` is now an **IT recovery tool only** — never called by the Agent, never run by end users. Otherwise someone will wire it back into the Agent repair dialog later.
  ---
  ### The verification checklist to run after Lovable applies this
  Run these in order after rebuilding and reinstalling:
  powershell
  ```powershell
  # 1. Confirm service is registered and running as LocalSystem
  sc.exe query ConnectLiveWatcher
  (Get-WmiObject Win32_Service -Filter "Name='ConnectLiveWatcher'").StartName

  # 2. Confirm running process is owned by SYSTEM not your user
  Get-WmiObject Win32_Process -Filter "Name='ConnectLiveService.exe'" |
    ForEach-Object { $o = $_.GetOwner(); "$($o.Domain)\$($o.User)" }

  # 3. Confirm no more CreateProcessAsUser failed messages
  Get-EventLog -LogName Application -Source "Application" -Newest 5 |
    Select-Object @{N='Msg'; E={$_.ReplacementStrings -join ' '}} |
    Format-List
  ```
  Step 3 should show `launched Agent pid=XXXX` instead of `CreateProcessAsUser failed`. That's your confirmation the entire fix worked.
  &nbsp;