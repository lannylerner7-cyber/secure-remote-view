## Watcher hardening + branding cleanup

### 1. Preserve session ID on respawn (`agent/watcher/Program.cs`)

When the admin closes the Agent UI manually, the Watcher respawns it on the next 5s tick. If that heartbeat's `sessions` array is momentarily empty (common right after a UI close while the row is still `is_session_active=true`), `activeSessionId` is `null` and the Agent gets relaunched with only `/WAKE` — no session context, so the admin can't reconnect.

Fix: fall back to `_lastLaunchedSessionId` so context is never lost across a respawn.

```csharp
var targetSessionId = activeSessionId ?? _lastLaunchedSessionId;
var args = targetSessionId != null
    ? $"/WAKE /SESSION=\"{targetSessionId}\""
    : "/WAKE";
```

And when computing `needsRelaunch`, compare against `targetSessionId` (not raw `activeSessionId`) so we don't force a needless relaunch just because the array blipped empty. Only clear `_lastLaunchedSessionId` on the existing "session ended" branch (already done).

### 2. Point Watcher at our production domain

`ApiBaseUrl` in `watcher/Program.cs` is currently `https://secure-remote-view.lovable.app` (the auto-generated Lovable subdomain). Switch to the project's custom domain `https://zoomlite.live` so the Watcher heartbeat hits the branded endpoint the rest of the stack advertises.

### 3. Rename installed binary to `ConnectLive.exe`

Watcher currently resolves `ConnectLiveAgent.exe`. Rename references so the Program Files install is `ConnectLive\ConnectLive.exe`:

- `InstalledAgentPath` → `...\ConnectLive\ConnectLive.exe`
- `ResolveAgentPath()` beside-fallback → `ConnectLive.exe`
- Update `agent/src/ConnectLiveAgent.csproj` `<AssemblyName>` from `ConnectLiveAgent` to `ConnectLive` so the build output matches.
- Update `agent/packaging/inno/ConnectLiveSetup.iss` to install/reference `ConnectLive.exe` (Files entry, service `binPath`, uninstall `CloseApplicationsFilter`, `UninstallDisplayIcon`).
- Update `agent/build.ps1` / `build.bat` to copy `ConnectLive.exe`.
- Update `agent/INSTALL.md` and any doc mentions.

### 4. Add ApplicationIcon to Watcher csproj

Add to `agent/watcher/ConnectLiveWatcher.csproj` `<PropertyGroup>` (guarded by `Condition="Exists(...)"` to keep Linux builds happy):

```xml
<ApplicationIcon Condition="Exists('..\assets\icon.ico')">..\assets\icon.ico</ApplicationIcon>
```

Agent csproj already has this guarded entry — no change needed there.

### 5. Repackage

Regenerate `ConnectLive-RemoteAgent-src.zip` (Agent changes only; Admin console untouched this pass).

### Out of scope

- No Admin Console changes — the fix is entirely in the supervision + branding layer.
- No backend/route changes; the heartbeat contract stays the same.
