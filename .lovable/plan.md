## Packaging the ConnectLive agent: MSI vs single-file EXE

Both work. Pick based on how you want IT to deploy it.

### Option A — Visual Studio Installer Projects (.msi)
Good when:
- You want a proper Windows installer with Add/Remove Programs entry.
- IT will push it via Group Policy / Intune / SCCM (those tools expect MSI).
- You want per-machine install into `Program Files` and an auto-start entry.

Steps (rough):
1. `dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true` in `agent/src` → produces `ConnectLiveAgent.exe`.
2. In Visual Studio, add a new "Setup Project", add the published EXE as the primary output, set the target folder to `[ProgramFiles64Folder]\ConnectLive`.
3. Optional: add a Registry key under `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` to auto-start, and a Start Menu shortcut.
4. Build → produces `ConnectLiveAgent.msi`.

### Option B — Command-line single-file EXE (what the zip already does)
Good when:
- End users just double-click to run (no admin install needed).
- You want the fastest iteration loop — one PowerShell command rebuilds it.

Already wired up in `agent/build.ps1`:
```
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
```

### Recommendation
- For **piloting / manual runs**: keep the single-file EXE (Option B).
- For **rolling out to staff machines**: wrap that same EXE in an MSI (Option A). MSI is just a delivery wrapper around the same binary — you don't rewrite the agent.

No code changes needed on our side for either path. Want me to add an `installer/` folder with a ready-to-open `.vdproj` scaffold pointing at the published EXE, or leave packaging entirely on your Visual Studio side?