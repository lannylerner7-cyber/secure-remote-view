## What the two screenshots show

- **Explorer**: `C:\Program Files\ConnectLive\` contains `ConnectLive.exe`, `ConnectLiveUpdater.exe`, `unins000.exe`, `unins000.dat` — so the Inno install itself laid the files down correctly.
- **Task Manager**: `ConnectLive Admin` and `ConnectLiveUpdater` are both running. **`ConnectLive.exe` (the Agent) is not in the list.** The Updater service is alive but the Agent it is supposed to spawn is not.

## Answering the earlier question

Deleting either `.exe` is **not** self-healing. There is no download/repair path in the code:
- `agent/updater/Program.cs` resolves the Agent via `ResolveAgentPath()` → `%ProgramFiles%\ConnectLive\ConnectLive.exe`, then beside itself, then the parent folder. If none exist it only logs `ConnectLive.exe missing at …` and keeps looping.
- Delete `ConnectLiveUpdater.exe` and the registered service fails at boot with Win32 error 2; nothing recreates it.

Recovery is re-running `ConnectLiveSetup.exe` (or `unins000.exe` first for a clean reinstall).

## Plan

**1. Fix the build failure (root cause of the whole mess)**

`agent/updater/ConnectLiveUpdater.csproj` sets `AssemblyName` = `ConnectLiveService`, so publish emits `ConnectLiveService.exe`, while `build.ps1` (line 90), `ConnectLiveSetup.iss`, `ConnectLive.wxs` and `install.ps1` all reference `ConnectLiveUpdater.exe`. That is the `Copy-Item … PathNotFound`.

- Set `<AssemblyName>ConnectLiveUpdater</AssemblyName>` — one line, and it matches the service name, firewall rules, taskkill entries and MSI component already in place.
- Harden `build.ps1`: after each publish, assert the expected binary exists and throw a message naming what was actually produced, and purge any stale `dist\ConnectLiveService.exe` so an old build can't leak into an installer.

Consequence: the `ConnectLiveUpdater.exe` currently on that machine is a **stale binary from an earlier build**, not today's output. The installed pair is mismatched — worth a clean uninstall + reinstall after the rebuild.

**2. Diagnose why the Agent isn't running**

Add nothing yet — first read the evidence the code already writes:
- `%ProgramData%\ConnectLive\updater-health.json` — the Updater's own view of whether it thinks the Agent is up.
- `%ProgramData%\ConnectLive\install.log` — service registration outcome.
- `%ProgramData%\ConnectLive\stop.flag` — if present, the Updater deliberately refuses to launch the Agent. A user closing the tray Agent writes this; nothing clears it except a wake command. **This is the most likely explanation for the screenshot.**
- HKCU `…\Run\ConnectLive` — should hold `"C:\Program Files\ConnectLive\ConnectLive.exe" /background`.

I'll tell you exactly which commands to run and read the output before changing behaviour.

**3. Re-package**

Once the assembly-name fix lands, regenerate the agent source zip under a new stamped filename.

## Not in scope unless you say so

- `SIPSorcery` 6.2.4 NU1903 high-severity advisory (warning only, build still succeeds).
- `WFAC010` high-DPI manifest warning and the `CS1998` at `Agent.cs:209` — both cosmetic.
- True self-repair (Updater re-downloading a deleted `ConnectLive.exe` from the server). Doable, but it needs a signed download endpoint plus a version manifest — a separate piece of work.
