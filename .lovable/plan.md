## Goal

1. Give the Admin console its own icon asset slot (`admin/assets/icon.ico`, which you drop in manually).
2. Tighten `agent/build.ps1`.
3. Fold the Updater back into `ConnectLiveSetup.iss` as an **optional** component (option C).

## 1. Admin icon asset

- Create `admin/assets/` with a `README.md` stating the required file: `icon.ico` (multi-res 16/32/48/256, 32-bit). You add the real `.ico` manually.
- `admin/src/ConnectLiveAdmin.csproj`: change `<ApplicationIcon>` from the agent path to prefer `..\..\assets\icon.ico` (admin's own), falling back to the agent icon only if the admin one is absent. Add the icon as `<Resource>` so WPF windows/taskbar can use it.
- `admin/src/Views/MainWindow.xaml` and `LiveSessionWindow.xaml`: add `Icon="pack://application:,,,/assets/icon.ico"` guarded so a missing file doesn't break the build (set in code-behind only when the resource exists — XAML hard-references fail at runtime if absent).
- `admin/build.ps1`: stage `assets/icon.ico` to `dist/` and include it in `ConnectLiveAdmin.zip` (harmless if missing; warn, don't fail).

## 2. `agent/build.ps1` corrections

- Publish steps stay. Fix the staging line `Copy-Item assets/* dist/ -Recurse` — it currently ships `logo.svg` into `dist` and swallows errors with `SilentlyContinue`; narrow it to `assets\icon.ico` and emit an explicit warning when missing (Inno's `SetupIconFile` needs it).
- Add a pre-flight check that `packaging\inno\ConnectLiveSetup.iss` and `packaging\msi\ConnectLive.wxs` exist before invoking `iscc` / `wix`, so a missing file fails with a clear message rather than a tool error.
- Add `-SkipUpdater` switch: when passed, skip the Updater restore/publish/stage and pass `/DNoUpdater` to `iscc` so the installer compiles Agent-only (matches Phase 1 default). Default remains: build both.
- Verify `OutputDir=..\..\dist` in the .iss resolves to `agent\dist` (it does) and keep zip packaging as-is.

## 3. `ConnectLiveSetup.iss` — Updater as optional component

- Add a `[Components]` section:
  - `agent` — "ConnectLive Agent (required)", `Types: full compact custom; Flags: fixed`
  - `updater` — "Background Updater service (optional, runs as LocalSystem; enables remote wake when the Agent is closed)", unchecked by default in compact.
- Wrap the Updater payload in `[Files]` with `Components: updater`, sourcing `..\..\dist\ConnectLiveUpdater.exe` into `{app}`.
- Service registration for the Updater goes in the existing `ssPostInstall` Pascal code path, executed only when `WizardIsComponentSelected('updater')`; reuse the native Service-API registration + state polling + `install.log` reporting already written for this project. Uninstall stops and deletes the service only if it was installed.
- Guard the whole Updater block with `{#ifndef NoUpdater}` so `-SkipUpdater` produces a clean Agent-only installer from the same script.
- Update the header comment block (currently says "Does NOT reference ConnectLiveUpdater.exe") to describe the optional component.
- Add firewall rule + `[UninstallRun]` taskkill for `ConnectLiveUpdater.exe`, both scoped to the component.

## Technical notes

- No changes to agent runtime code, routes, or endpoints — packaging and icon wiring only.
- The Agent keeps its own HKCU-Run persistence; the Updater component is purely additive for wake- when agent quite -closed.
- After the edits I'll repackage `ConnectLive-RemoteAgent-src.zip` and `ConnectLive-AdminConsole-src.zip`.