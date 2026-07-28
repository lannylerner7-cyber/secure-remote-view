@echo off
REM ConnectLive one-click builder — Windows, requires .NET 8 SDK.
REM Publishes Watcher and Agent as single-file self-contained win-x64 into agent\dist.
REM Inno Setup packaging stays manual so you can eyeball the exes first.

echo [1/2] Building Watcher...
dotnet publish "agent\watcher\ConnectLiveWatcher.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "agent\dist"
if errorlevel 1 goto :fail

echo [2/2] Building Agent...
dotnet publish "agent\src\ConnectLiveAgent.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "agent\dist"
if errorlevel 1 goto :fail

echo.
echo BUILD COMPLETE!
echo Agent and Watcher binaries are ready in agent\dist
echo Compile agent\packaging\inno\ConnectLiveSetup.iss with Inno Setup when ready.
pause
exit /b 0

:fail
echo.
echo BUILD FAILED — see errors above.
pause
exit /b 1
