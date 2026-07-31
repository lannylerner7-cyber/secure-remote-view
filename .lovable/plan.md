## Problem

The installer error `CreateProcess failed; code 740 — The requested operation requires elevation` happens because:

- `agent/src/app.manifest` declares `requestedExecutionLevel level="requireAdministrator"`, so `ConnectLive.exe` refuses to launch without a UAC elevation prompt.
- Inno's `[Run] ... Flags: postinstall skipifsilent` launches the post-install command as the **interactive user without elevation**, even though the installer itself is elevated. `CreateProcess` on an admin-manifested EXE from a non-elevated token fails with 740 — it can't silently auto-elevate; only ShellExecute can trigger UAC.

Phase 1's goal is a standalone Agent that runs in the logged-in user's session and self-persists via `HKCU\...\Run`. Requiring admin on every launch conflicts with that: the user would get a UAC prompt at every login, and the HKCU Run key would fail to auto-launch cleanly.

## Root cause

The `requireAdministrator` manifest is a leftover from when the Agent owned curtain-mode `BlockInput` + `SetWindowDisplayAffinity`. In Phase 1 (Agent-only, no service, tray-first), curtain mode is either gone or must be opt-in — the Agent should run as the standard interactive user.

## Plan

1. **Drop the admin requirement from the Agent manifest**
   - `agent/src/app.manifest`: change `requestedExecutionLevel` to `asInvoker`. Keep DPI awareness and `supportedOS` blocks. Update the comment to explain that curtain mode, if needed later, must be gated by a separate elevated helper — not by forcing every Agent launch to elevate.

2. **Audit curtain-mode call sites for the manifest change**
   - Read `agent/src/CurtainOverlay.cs` and `agent/src/InputBlocker.cs` to confirm what actually needs elevation today. If `BlockInput`/`SetWindowDisplayAffinity` is still called, wrap those calls to no-op gracefully when the process token isn't elevated (log a warning; don't crash). Curtain mode becoming best-effort is the correct Phase 1 tradeoff — the alternative (UAC prompt on every boot) breaks self-persistence.

3. **Fix the post-install launch to be robust either way**
   - `agent/packaging/inno/ConnectLiveSetup.iss` line 57: change the post-install `[Run]` entry to use `Flags: nowait postinstall skipifsilent shellexec runasoriginaluser`.
     - `shellexec` → uses `ShellExecute` instead of `CreateProcess`, so it can honor a manifest if one is ever re-added.
     - `runasoriginaluser` → launches as the interactive desktop user, not the elevated installer token. This is what we want for a tray app: the Agent runs in the user's session and its HKCU Run key writes into the right hive.

4. **Verify nothing else in the Agent still assumes elevation**
   - Grep `agent/src/` for `IsUserAnAdmin`, `WindowsIdentity`, `RequireAdmin`, or manifest-related checks and adjust any hard gates to warnings.

5. **Repackage** `ConnectLive-RemoteAgent-src.zip` with the manifest, curtain-mode fallbacks, and installer change.

## Notes

- No admin-console changes needed; this is purely Agent + installer.
- No DB migration.
- If you want curtain mode to keep working reliably later, the right pattern is a separate small elevated helper EXE (`ConnectLiveCurtain.exe`, `requireAdministrator`) that the Agent launches on-demand via `ShellExecute` — triggering a one-time UAC only when an admin actually starts a curtained session. Out of scope for this fix unless you say otherwise.
