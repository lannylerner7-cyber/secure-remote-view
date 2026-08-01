## Problem

The updated packages were written as `ConnectLiveAgent.zip` and `ConnectLiveAdmin.zip` — the same names as the older files already sitting in the generated-files list (`ConnectLive-RemoteAgent-src.zip`, `ConnectLive-AdminConsole-src.zip`, `ConnectLive-RemoteAgent.zip`, `ConnectLive-AdminConsole.zip`). That makes it impossible to tell at a glance which download is the current one.

No page in the app links to these zips — they are download artifacts only — so renaming breaks nothing.

## Plan

1. Repackage both source trees under date-and-version-stamped names:
   - `ConnectLive-RemoteAgent-src-v1.1-20260801.zip`
   - `ConnectLive-AdminConsole-src-v1.1-20260801.zip`

   Same exclusions as before (`dist/`, `publish/`, `bin/`, `obj/`), so only source, build scripts, and packaging files ship.

2. Write them to `/mnt/documents/` alongside — not over — the existing files, and mirror them into `public/` for direct URL download.

3. Delete the ambiguous `public/ConnectLiveAgent.zip` and `public/ConnectLiveAdmin.zip` I created in the last turn so only the stamped names remain in the served folder. Leave every older file in `/mnt/documents/` untouched.

4. Verify each new zip's manifest contains the current `agent/build.ps1` (with `-SkipUpdater`), `agent/packaging/inno/ConnectLiveSetup.iss` (optional-Updater component), `admin/src/Ui/AppIcon.cs`, and `admin/assets/README.md`, then surface both as downloadable artifacts.

## Technical notes

The version stamp is fixed text in the filename, not read from the csproj — the agent's `build.ps1` computes its own MSI/Inno version at build time and is unaffected by what the source archive is called.
