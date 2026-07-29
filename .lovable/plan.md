## Current state

The agent/watcher were recently switched from `https://secure-remote-view.lovable.app` to the custom domain `https://zoomlite.live`, and the agent binary was renamed to `ConnectLive.exe`. The native admin client still embeds the old Lovable subdomain in its defaults and sample config.

## What needs to change in the admin zip

Only URL alignment is required. The admin already uses the keyless `/api/public/auth/login` flow and does not reference the agent binary directly, so no deployment-key or binary-name changes are needed.

### Files to update

1. **`admin/src/Api/AppConfig.cs`**
   - Change the default `BaseUrl` from `https://secure-remote-view.lovable.app` to `https://zoomlite.live`.
   - Change the fallback `BaseUrl` in `Load()` to `https://zoomlite.live`.

2. **`admin/src/admin.config.json`**
   - Change `baseUrl` from `https://secure-remote-view.lovable.app` to `https://zoomlite.live`.

3. **`admin/INSTALL.md`**
   - Update the web panel URL example from `https://secure-remote-view.???.lovable.app/console?tab=payments` to `https://zoomlite.live/console?tab=payments`.
   - Update the `baseUrl` example in the config block to `https://zoomlite.live`.

### Verification

- Search the `admin/` tree for any remaining `secure-remote-view.lovable.app`, `ConnectLiveAgent.exe`, `deployment.key`, or `DeploymentKey` references.
- Confirm the `admin/build.ps1` output name remains `ConnectLiveAdmin.exe` (no rename needed for the admin console).

### Deliverable

Repackage `ConnectLive-AdminConsole-src.zip` with the updated source files.

## What stays the same

- Admin binary name: `ConnectLiveAdmin.exe`
- Login endpoint: `/api/public/auth/login`
- Supabase URL/key in fallback config
- Build script (`admin/build.ps1`)
- Icon reference (`..\..\agent\assets\icon.ico`)