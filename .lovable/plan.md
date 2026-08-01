## Verified current state (checked before writing this)

- `agent/packaging/inno/ConnectLiveSetup.iss` has **no `[Registry]` section** — the installer does *not* write the HKCU Run key. It only launches the exe post-install with `/background`. So today there is exactly **one** writer: `StartupRegistration.cs`. The "two writers" concern doesn't exist yet, but the path guard you asked for is still worth having.
- `power_commands_kind_check` **already allows** `wake_agent`, `restart_stream`, `restart_agent` (plus wake/reboot/shutdown/lock/logoff). No constraint change needed.
- `supabase_realtime` publication currently carries devices, sessions, session_frames, session_signals, session_cursors, notifications — **`power_commands` is missing**.
- `WinApi.LaunchInSession` (agent/watcher/Program.cs ~654) already does `WTSQueryUserToken` → `DuplicateTokenEx` → `CreateEnvironmentBlock` → `CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE`. Missing: `LoadUserProfile`, `DETACHED_PROCESS` instead of `CREATE_NEW_CONSOLE`, and per-step failure logging.
- `App.xaml.cs` arg parsing accepts `/BACKGROUND`, `--background`, `/MINIMIZED`, `--minimized` — all case-insensitive via `OrdinalIgnoreCase`. Any casing works.

## (a) StartupRegistration.cs — installer-consistent Run key

- Keep value format exactly `"<exe path>" /background` (lowercase, matching what the installer passes on post-install launch; parsing is case-insensitive so this is safe either way).
- Add an **install-location guard**: resolve the current exe path and compare its directory against the installed location, read from `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{B4E9A1C2-...CONNECTLIVE500}_is1\InstallLocation`, falling back to `%ProgramFiles%\ConnectLive`. If the running exe is **not** under that directory, log `startup: dev/non-installed path — Run key left untouched` and return without writing or deleting. A dev `dist\` run can never clobber the installed key.
- Keep the existing idempotent compare-then-write and the swallow-all-errors behavior.

## (b) WinApi.LaunchInSession — token/env hardening (in place, no new file)

Modify the existing method only:
- Call `LoadUserProfile` on the duplicated token before `CreateEnvironmentBlock` so `HKCU` is mounted for the target session; `UnloadUserProfile` in the `finally` block.
- Build the env block from the token *after* the profile is loaded.
- Replace `CREATE_NEW_CONSOLE` with `DETACHED_PROCESS` (keeping `CREATE_UNICODE_ENVIRONMENT`) so the WPF Agent never flashes a console window.
- Log `Marshal.GetLastWin32Error()` at each failing step (`WTSQueryUserToken`, `DuplicateTokenEx`, `CreateProcessAsUser`) instead of a bare `return false`, so the "Agent not launched this tick" warning becomes diagnosable.
- Add the required P/Invokes (`LoadUserProfile`/`UnloadUserProfile`, `PROFILEINFO`) and `SetLastError = true` where missing.

## (c) Migration — realtime publication only

- `ALTER PUBLICATION supabase_realtime ADD TABLE public.power_commands;`
- `ALTER TABLE public.power_commands REPLICA IDENTITY FULL;`
- `session_signals` is already published; leave it alone.
- No constraint change (already correct), no RLS/grant change, no client-side Supabase key anywhere — the SSE gateway remains the only reader.

## Explicitly not doing

No `SupabaseSocket.cs`, no `SessionInjector.cs`, no `agent-alive.json`, no heartbeat-loop removal, no installer `[Registry]` section added, no other file touched.

## Output

Repackage `ConnectLive-RemoteAgent-src.zip` after the agent/watcher edits.
