## Confirmed diagnosis

- The screenshot’s `power_commands_kind_check` error is from an older/stale attempt. The live database constraint already permits `wake_agent`, and there are currently three queued `wake_agent` rows. The current failure is downstream: no running Watcher is consuming them.
- `ConnectLiveWatcher` is a Windows Service. It should appear in **Task Manager → Services/Details** and `services.msc`, not in **Startup Apps**.
- Opening `ConnectLive.exe` manually does not install or start the Watcher. Only the installer or elevated install script can register the LocalSystem service.
- The shipped manual-install path is broken: the ZIP places both EXEs beside `install.ps1`, but `install.ps1` searches source build folders instead.
- The root `build.bat` also copies the obsolete filename `ConnectLiveAgent.exe`, while the project actually publishes `ConnectLive.exe`.

## Implementation plan

1. **Repair the build/package pipeline**
   - Update `build.bat` to copy and archive `ConnectLive.exe` consistently.
   - Ensure the remote-agent package always contains `ConnectLive.exe`, `ConnectLiveWatcher.exe`, the elevated installer, and clear install/repair instructions.
   - Add packaging checks that fail immediately if either binary is missing instead of producing a partial archive.

2. **Make Watcher installation reliable**
   - Refactor `agent/install.ps1` to install binaries from beside the script first, with source publish folders only as a development fallback.
   - Register `ConnectLiveWatcher` as delayed auto-start under LocalSystem, configure restart-on-failure, apply the same service permissions as the Inno installer, start it, and verify it reaches `Running` state.
   - Correct uninstall cleanup to terminate `ConnectLive.exe`, not the obsolete `ConnectLiveAgent` process name.
   - Keep the Inno installer as the preferred production path and align both installation methods.

3. **Add visible service-health diagnostics**
   - Have the interactive Agent detect whether `ConnectLiveWatcher` is missing or stopped at startup.
   - Show a precise repair message rather than silently running an unsupervised Agent; provide an elevated repair/start action when the packaged installer script is available.
   - Add a Watcher health/status file under `%ProgramData%\ConnectLive` alongside Windows Event Log entries so installation and runtime failures can be diagnosed without guessing.

4. **Harden supervision and prevent duplicate Agents**
   - Add a global single-instance guard to `ConnectLive.exe`.
   - Update Watcher liveness detection so it recognizes an already-running installed Agent, not only a process it launched itself.
   - Preserve active session context and respawn the Agent after manual closure while the session remains active.

5. **Make reconnect status truthful**
   - Keep the existing `wake_agent` schema—no database migration is needed because the live constraint is already correct.
   - Update native and web admin reconnect paths to check the command insert result and report “wake queued” only after persistence succeeds.
   - Surface “Watcher offline/not consuming commands” when a command remains queued, rather than showing a generic stale constraint banner.
   - Preserve the current 15-second auto-clear behavior for transient native-admin banners.

6. **Verify the complete Windows flow**
   - Add static checks for binary names, service registration commands, allowed power-command kinds, and all Watcher endpoints.
   - Verify the intended sequence: install → service running → device heartbeat → close Agent → reconnect queues `wake_agent` → Watcher consumes/ACKs it → Agent respawns into the active session.
   - Repackage the corrected Remote Agent source/package after verification.