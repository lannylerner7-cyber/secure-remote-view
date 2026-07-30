## What the screenshot actually shows

This is not a C# error and not an Inno error. It is Windows Installer's own upgrade rule firing:

- `ConnectLive.wxs` hardcodes `Version="1.0.0.0"` with a fixed `UpgradeCode`.
- `<MajorUpgrade>` defaults to `AllowSameVersionUpgrades="no"`, so installing 1.0.0.0 when 1.0.0.0 is already present is treated as a downgrade/same-version conflict and shows exactly the string in your `DowngradeErrorMessage`: "A newer version of ConnectLive Agent is already installed."

So every rebuild produces an MSI that refuses to install over the previous one unless it is uninstalled first. The Inno path was skipped separately because `iscc` was not on PATH (the script only warns and continues), which is why the run ended with only an MSI.

A second, quieter problem: `build.ps1` **rewrites** `packaging/msi/ConnectLive.wxs` from an inline here-string on every build. The tracked file in the repo (older schema, `DEPLOYMENT_KEY` custom action, `src\bin\...\publish` sources, no `service\` subfolder) is therefore dead code that silently diverges from what is actually compiled.

## Plan

1. **Make the MSI reinstallable**
   - Add `AllowSameVersionUpgrades="yes"` and `Schedule="afterInstallInitialize"` to `<MajorUpgrade>` so a rebuild of the same version cleanly replaces the previous install instead of erroring.
   - Keep `DowngradeErrorMessage` for genuinely older packages.

2. **Give the MSI a real, moving version**
   - Introduce a `-Version` parameter in `build.ps1` (default derived from date/build counter, e.g. `1.0.<yyyyMMdd>.<HHmm>`-style 4-part numeric).
   - Pass it to WiX with `-d Version=$Version` and change the `.wxs` to `Version="$(Version)"` so consecutive builds are always upgrades, never same-version collisions.

3. **Stop the dual-source `.wxs` drift**
   - Remove the inline here-string generation from `build.ps1`; build the tracked `packaging/msi/ConnectLive.wxs` directly.
   - Update the tracked `.wxs` to the current, correct content: `dist\ConnectLive.exe` and `dist\ConnectLiveService.exe` sources, `service\` subfolder for the service binary, `DelayedAutostart` registry value, `AuthenticatedUsers` PermissionEx via GenericRead/GenericWrite/Delete, and drop the obsolete `DEPLOYMENT_KEY` custom action (deployment keys were removed from the enrollment flow).

4. **Make a missing toolchain loud instead of silent**
   - `iscc` or `wix` missing currently only warns. Change to fail the build unless the matching `-SkipInno` / `-SkipMsi` switch was passed, so you never again get a run that quietly produces just one artifact.

5. **Add an uninstall-first escape hatch**
   - Document in `agent/INSTALL.md`: if a machine is stuck with a prior install, `msiexec /x {UpgradeCode-derived ProductCode} /qn` or Apps & Features removal, then reinstall. With step 1+2 in place this should stop being necessary.

6. **Repackage**
   - Refresh `ConnectLive-RemoteAgent-src.zip` with the corrected `build.ps1`, `.wxs`, and docs.

## Technical notes

- No C# source changes are required for this failure; the Agent and Watcher code is untouched by this plan.
- `AllowSameVersionUpgrades="yes"` can produce ICE61 warnings at build time; that is expected and harmless for a per-machine agent MSI.
- The Inno `.iss` path already uses native SCM APIs and stays as the interactive installer; the MSI remains the Intune/GPO artifact.
