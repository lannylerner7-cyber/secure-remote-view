## Fix: "ConnectLive Service did not start correctly" at install time

### Root cause
`CurStepChanged(ssInstall)` runs **before** Inno copies the `[Files]` entries to disk. `SetupWatcherService` registers the service and calls `sc start` while `{app}\service\ConnectLiveService.exe` doesn't exist yet, so SCM fails to launch the binary. By the time `ssPostInstall` checks with `sc interrogate`, the file exists but the service is stuck in a stopped/failed state, and the warning dialog fires.

### Changes to `agent/packaging/inno/ConnectLiveSetup.iss`

1. **Move service setup to `ssPostInstall`** — remove the `ssInstall` branch; call `SetupWatcherService` first inside `ssPostInstall`, then `Sleep(4000)`, then run the `IsServiceRunning` health check. This guarantees the binary is on disk before `sc create` / `sc start`.

2. **Capture and log every `sc.exe` exit code** — introduce a `ScExec(args, label)` helper that runs `sc.exe`, stores the return code, and appends `label + ExitCode` to a plain-text log at `{commonappdata}\ConnectLive\install.log` via `SaveStringToFile(..., True)`. Every `Exec` call in `StopWatcherService` and `SetupWatcherService` goes through it. The health-check dialog text gains one line: "See %ProgramData%\ConnectLive\install.log for details."

3. **Retry `sc start` once on failure** — if the first `start` returns non-zero, `Sleep(2000)` and retry. Covers transient SCM contention when a prior uninstall hasn't fully released the service handle.

4. **Verify the binary exists before registering** — guard `SetupWatcherService` with `FileExists(BinPath)`; if false, log `binary_missing` and skip (prevents a silently broken registration from lingering).

5. **Keep `StopWatcherService` on `BeforeInstall`** — it correctly runs before file overwrite to release the exe lock. No change to that hook.

### Not changing
- `agent/watcher/Program.cs` `ResolveAgentPath()` — already walks one directory up from `AppContext.BaseDirectory`, so `{app}\service\` layout still finds `{app}\ConnectLive.exe`.
- Service name (`ConnectLiveWatcher`), binary name (`ConnectLiveService.exe`), SDDL hardening, firewall rules, uninstall order — all correct.
- `build.bat`, `agent/build.ps1`, `agent/install.ps1` — unaffected.

### Deliverable
Repackage `ConnectLive-RemoteAgent-src.zip` with the updated `.iss`. Admin zip untouched.

### How to verify after rebuild
1. `iscc agent\packaging\inno\ConnectLiveSetup.iss`
2. Run `ConnectLiveSetup.exe` — no warning dialog, `services.msc` shows **ConnectLive Service** as *Running*.
3. Open `%ProgramData%\ConnectLive\install.log` — every `sc.exe` line ends with `ExitCode=0`.
4. Close the Agent from the tray → within ~1 s the Watcher's SSE loop respawns it (existing behavior, now that the service is actually alive).
