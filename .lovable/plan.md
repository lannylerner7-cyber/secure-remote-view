## Short answer

Yes — the agent zip is stale and needs a new output. The admin zip does not.

The last agent archive (`ConnectLive-RemoteAgent-src.zip`) was built before this turn's changes. Since then these agent-side files changed:

- `agent/src/App.xaml.cs` — Watcher spawn/repair logic removed, read-only service status probe only
- `agent/watcher/ConnectLiveWatcher.csproj` — assembly renamed to `ConnectLiveService.exe`
- `agent/watcher/Program.cs` — third agent-path fallback in `ResolveAgentPath()`
- `agent/build.ps1`, `build.bat` — new binary filename
- `agent/install.ps1` — service create path, uninstall process guard
- `agent/packaging/inno/ConnectLiveSetup.iss` + `README.md` — source files, firewall rules, `watcher-health.json` cleanup
- `agent/packaging/msi/ConnectLive.wxs`, `agent/INSTALL.md` — filename/doc updates

No admin-side file changed this turn, so `ConnectLive-AdminConsole-src.zip` from the previous build is still current.

## Plan

1. Sanity-check the agent tree for leftover `ConnectLiveWatcher.exe` / `ConnectLiveAgent.exe` filename references (service name `ConnectLiveWatcher` stays as-is).
2. Repackage `agent/` (src, watcher, packaging, build/install scripts, docs) into a fresh `ConnectLive-RemoteAgent-src.zip`.
3. Verify the archive listing contains the renamed watcher project and updated installer script, then hand over the download link.

Admin archive left untouched unless you want it re-cut for version parity.
