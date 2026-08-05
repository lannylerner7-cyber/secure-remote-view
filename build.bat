@echo off
REM ConnectLive one-click builder — Windows, requires .NET 8 SDK.
REM Publishes the standalone Agent and the Admin Console as single-file,
REM self-contained win-x64 binaries, then zips each side into a bundle:
REM   agent\dist\ConnectLive-RemoteAgent.zip
REM   admin\dist\ConnectLive-AdminConsole.zip
REM
REM There is no updater/watcher service — the Agent is standalone and
REM self-persistent (HKCU Run key + Startup shortcut + ONLOGON task).

echo [1/3] Building Agent...
dotnet publish "agent\src\ConnectLiveAgent.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "agent\publish\agent"
if errorlevel 1 goto :fail

echo [2/3] Building Admin Console...
dotnet publish "admin\src\ConnectLiveAdmin.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "admin\publish\admin"
if errorlevel 1 goto :fail

echo [3/3] Packaging zips...

REM ---- Agent zip -----------------------------------------------------------
if not exist "agent\dist" mkdir "agent\dist"
copy /Y "agent\publish\agent\ConnectLive.exe" "agent\dist\" >nul
if errorlevel 1 goto :fail
copy /Y "agent\INSTALL.md" "agent\dist\README-INSTALL.txt" >nul
if not exist "agent\dist\ConnectLive.exe" goto :fail

REM Purge stale helper binaries from older full builds so they cannot ship.
if exist "agent\dist\ConnectLiveUpdater.exe" del "agent\dist\ConnectLiveUpdater.exe"
if exist "agent\dist\ConnectLiveService.exe" del "agent\dist\ConnectLiveService.exe"

REM S25 - sign the agent exe before it is zipped (no-op with a warning when
REM no CODESIGN_* env var is set). See docs\SIGNING.md.
powershell -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0tools\CodeSign.ps1'; Invoke-ConnectLiveSign -Paths @('%~dp0agent\dist\ConnectLive.exe')"
if errorlevel 1 goto :fail

if exist "agent\dist\ConnectLive-RemoteAgent.zip" del "agent\dist\ConnectLive-RemoteAgent.zip"
powershell -NoProfile -Command "Compress-Archive -Path 'agent\dist\ConnectLive.exe','agent\dist\README-INSTALL.txt' -DestinationPath 'agent\dist\ConnectLive-RemoteAgent.zip' -Force"
if errorlevel 1 goto :fail

REM ---- Admin zip -----------------------------------------------------------
if not exist "admin\dist" mkdir "admin\dist"
copy /Y "admin\publish\admin\ConnectLiveAdmin.exe" "admin\dist\" >nul
if errorlevel 1 goto :fail
copy /Y "admin\src\admin.config.json" "admin\dist\" >nul
copy /Y "admin\INSTALL.md" "admin\dist\README-INSTALL.txt" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0tools\CodeSign.ps1'; Invoke-ConnectLiveSign -Paths @('%~dp0admin\dist\ConnectLiveAdmin.exe')"
if errorlevel 1 goto :fail

if exist "admin\dist\ConnectLive-AdminConsole.zip" del "admin\dist\ConnectLive-AdminConsole.zip"
powershell -NoProfile -Command "Compress-Archive -Path 'admin\dist\ConnectLiveAdmin.exe','admin\dist\admin.config.json','admin\dist\README-INSTALL.txt' -DestinationPath 'admin\dist\ConnectLive-AdminConsole.zip' -Force"
if errorlevel 1 goto :fail

echo.
echo BUILD COMPLETE!
echo   Agent bundle: agent\dist\ConnectLive-RemoteAgent.zip
echo   Admin bundle: admin\dist\ConnectLive-AdminConsole.zip
echo.
echo Signing: automatic when CODESIGN_* env vars are set - see docs\SIGNING.md.
pause
exit /b 0

:fail
echo.
echo BUILD FAILED — see errors above.
pause
exit /b 1
