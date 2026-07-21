# ConnectLive Agent — Build & Install (Windows, CMD)

Compile the agent yourself from source. Every request the binary makes is
listed in `src/shared/api-routes.ts` on the server side, and mirrored in
`src/ApiClient.cs` here — no hidden endpoints.

## 1. Prerequisites (one-time)

Install the .NET 8 SDK on the build machine:

    winget install Microsoft.DotNet.SDK.8

Verify:

    dotnet --version

## 2. Extract & build (CMD)

    cd %USERPROFILE%\Downloads
    tar -xf ConnectLiveAgent.zip
    cd ConnectLiveAgent\src

Restore + run in dev. Curtain mode (BlockInput + capture-hidden overlay)
needs elevation, so launch CMD **as Administrator** for dev runs:

    dotnet run
    :: or explicitly:
    dotnet run -- --api-url https://secure-remote-view.lovable.app

Publish a signed single-file EXE for production:

    dotnet publish ConnectLiveAgent.csproj ^
      -c Release -r win-x64 --self-contained true ^
      -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true ^
      -o ..\dist

Output: `agent\dist\ConnectLiveAgent.exe` (~60 MB, self-contained).
The manifest requests `requireAdministrator`, so double-clicking the EXE
triggers a UAC prompt once at launch.


## 3. Install on an end-user machine (CMD, admin)

Copy the EXE + write the gateway URL, then launch:

    mkdir "%ProgramFiles%\ConnectLive"
    copy ConnectLiveAgent.exe "%ProgramFiles%\ConnectLive\"
    mkdir "%ProgramData%\ConnectLive"
    echo {"ApiBaseUrl":"https://secure-remote-view.lovable.app"} > "%ProgramData%\ConnectLive\config.json"
    :: Standing consent — the local user grants ongoing helpdesk access once.
    :: Delete this file to revert to per-session prompts.
    echo granted > "%ProgramData%\ConnectLive\consent.flag"
    "%ProgramFiles%\ConnectLive\ConnectLiveAgent.exe"

To auto-start at login:

    schtasks /Create /SC ONLOGON /TN "ConnectLive Agent" ^
      /TR "\"%ProgramFiles%\ConnectLive\ConnectLiveAgent.exe\"" /RL HIGHEST /F

## 4. Uninstall

    schtasks /Delete /TN "ConnectLive Agent" /F
    taskkill /IM ConnectLiveAgent.exe /F 2>nul
    rmdir /S /Q "%ProgramFiles%\ConnectLive"
    rmdir /S /Q "%ProgramData%\ConnectLive"

## 5. What the agent does — and does not do

Does:
- Enroll once (`POST /api/public/agent/enroll`), store the device token via
  DPAPI under `%ProgramData%\ConnectLive\device.dat`.
- Say hello on start (`POST /api/public/agent/hello`).
- Heartbeat every 20s (`POST /api/public/agent/heartbeat`) to pick up session
  invites; exponential backoff on network loss.
- Show the branded splash + persistent tray icon while running.
- Prompt the local user for consent before any View or Control session
  starts, and show a non-dismissible on-screen banner for the duration.

Does not:
- Auto-accept consent, hide the session banner, or run headless.
- Ship any third-party trademarked assets.
