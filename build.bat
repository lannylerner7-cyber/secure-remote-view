@echo off
REM ConnectLive one-click builder — Windows, requires .NET 8 SDK.
REM Publishes Agent, Watcher, and Admin as single-file, self-contained
REM win-x64 binaries, then zips each side into a shippable bundle:
REM   agent\dist\ConnectLive-RemoteAgent.zip
REM   admin\dist\ConnectLive-AdminConsole.zip

echo [1/4] Building Watcher...
dotnet publish "agent\watcher\ConnectLiveWatcher.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "agent\publish\watcher"
if errorlevel 1 goto :fail

echo [2/4] Building Agent...
dotnet publish "agent\src\ConnectLiveAgent.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "agent\publish\agent"
if errorlevel 1 goto :fail

echo [3/4] Building Admin Console...
dotnet publish "admin\src\ConnectLiveAdmin.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "admin\publish\admin"
if errorlevel 1 goto :fail

echo [4/4] Packaging zips...

REM ---- Agent zip -----------------------------------------------------------
if not exist "agent\dist" mkdir "agent\dist"
copy /Y "agent\publish\agent\ConnectLive.exe" "agent\dist\" >nul
if errorlevel 1 goto :fail
copy /Y "agent\publish\watcher\ConnectLiveWatcher.exe" "agent\dist\" >nul
if errorlevel 1 goto :fail
copy /Y "agent\install.ps1" "agent\dist\" >nul
copy /Y "agent\run-elevated.ps1" "agent\dist\" >nul
copy /Y "agent\INSTALL.md" "agent\dist\README-INSTALL.txt" >nul
if not exist "agent\dist\ConnectLive.exe" goto :fail
if not exist "agent\dist\ConnectLiveWatcher.exe" goto :fail
if exist "agent\dist\ConnectLive-RemoteAgent.zip" del "agent\dist\ConnectLive-RemoteAgent.zip"
powershell -NoProfile -Command "Compress-Archive -Path 'agent\dist\ConnectLive.exe','agent\dist\ConnectLiveWatcher.exe','agent\dist\install.ps1','agent\dist\run-elevated.ps1','agent\dist\README-INSTALL.txt' -DestinationPath 'agent\dist\ConnectLive-RemoteAgent.zip' -Force"
if errorlevel 1 goto :fail

REM ---- Admin zip -----------------------------------------------------------
if not exist "admin\dist" mkdir "admin\dist"
copy /Y "admin\publish\admin\ConnectLiveAdmin.exe" "admin\dist\" >nul
copy /Y "admin\src\admin.config.json" "admin\dist\" >nul
copy /Y "admin\INSTALL.md" "admin\dist\README-INSTALL.txt" >nul
if exist "admin\dist\ConnectLive-AdminConsole.zip" del "admin\dist\ConnectLive-AdminConsole.zip"
powershell -NoProfile -Command "Compress-Archive -Path 'admin\dist\ConnectLiveAdmin.exe','admin\dist\admin.config.json','admin\dist\README-INSTALL.txt' -DestinationPath 'admin\dist\ConnectLive-AdminConsole.zip' -Force"
if errorlevel 1 goto :fail

echo.
echo BUILD COMPLETE!
echo   Agent bundle: agent\dist\ConnectLive-RemoteAgent.zip
echo   Admin bundle: admin\dist\ConnectLive-AdminConsole.zip
echo.
echo Optional: sign each .exe with your code-signing cert before shipping.
pause
exit /b 0

:fail
echo.
echo BUILD FAILED — see errors above.
pause
exit /b 1
