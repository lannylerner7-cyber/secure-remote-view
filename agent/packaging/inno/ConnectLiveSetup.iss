; ConnectLive Remote Agent — Inno Setup script
;
; PREREQUISITE: run `build.bat` at the repo root first — this script consumes
;   agent\dist\ConnectLiveAgent.exe and agent\dist\ConnectLiveWatcher.exe.
;
; Build the installer:
;   iscc agent\packaging\inno\ConnectLiveSetup.iss
;
; Silent install (no deployment key required — first-boot auto-enrollment):
;   ConnectLiveSetup.exe /VERYSILENT

[Setup]
AppName=ConnectLive Remote Agent
AppVersion=1.2
AppPublisher=ConnectLive
DefaultDirName={autopf}\ConnectLive
DefaultGroupName=ConnectLive
DisableProgramGroupPage=yes
; Strict Admin Enforcement & Elevation
PrivilegesRequired=admin
OutputBaseFilename=ConnectLiveSetup
Compression=lzma2/ultra
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\ConnectLiveAgent.exe
; Auto-close running binaries before upgrade/uninstall
CloseApplications=yes
RestartApplications=no

[Dirs]
; ProgramData directory holds the DPAPI-encrypted device.dat that the Watcher
; writes on first-boot auto-enroll. SYSTEM full control (Watcher runs as
; LocalSystem); Users read+exec so the interactive Agent can migrate legacy
; credentials if any exist from earlier installs.
Name: "{commonappdata}\ConnectLive"; Permissions: owners-full admins-full system-full users-readexec

[Files]
; Pull single-file binaries from build output (this .iss lives in agent\packaging\inno\).
; BeforeInstall stops the service so the LocalSystem process releases its exe lock
; before Inno copies the new file — CloseApplications=yes / Restart Manager
; does not cover services holding an exe.
Source: "..\..\dist\ConnectLiveAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\ConnectLiveWatcher.exe"; DestDir: "{app}"; Flags: ignoreversion; BeforeInstall: StopWatcherService

[Run]
; 1. Clean up any existing service instance prior to re-registering (prevents reinstall lockups)
Filename: "{sys}\sc.exe"; Parameters: "stop ConnectLiveWatcher"; Flags: runhidden; Check: ServiceExists('ConnectLiveWatcher')
Filename: "{sys}\sc.exe"; Parameters: "delete ConnectLiveWatcher"; Flags: runhidden; Check: ServiceExists('ConnectLiveWatcher')

; 2. Register the Watcher as a Windows Service (Delayed AutoStart, LocalSystem)
Filename: "{sys}\sc.exe"; Parameters: "create ConnectLiveWatcher binPath= ""{app}\ConnectLiveWatcher.exe"" start= delayed-auto obj= LocalSystem DisplayName= ""ConnectLive Watcher"""; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "description ConnectLiveWatcher ""Maintains ConnectLive agent presence and spawns the interactive worker for remote support sessions."""; Flags: runhidden
; Mirror install.ps1's self-heal policy: restart at 5s / 10s / 30s, reset counter after 60s.
Filename: "{sys}\sc.exe"; Parameters: "failure ConnectLiveWatcher reset= 60 actions= restart/5000/restart/10000/restart/30000"; Flags: runhidden

; 3. Add outbound firewall rules for both Agent and Watcher (HTTPS Port 443)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLiveAgent.exe"" protocol=TCP remoteport=443"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Watcher Outbound"" dir=out action=allow program=""{app}\ConnectLiveWatcher.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; 4. Boot the Watcher service immediately post-install — it will auto-enroll
;    against /api/public/agent/enroll and DPAPI-encrypt the resulting token
;    into %ProgramData%\ConnectLive\device.dat. No operator input required.
Filename: "{sys}\sc.exe"; Parameters: "start ConnectLiveWatcher"; Flags: runhidden

[UninstallRun]
; Order matters: stop → delete → kill orphaned Agent → firewall cleanup.
; Deleting before killing prevents SCM from auto-restarting the Watcher
; between our stop and delete calls.
Filename: "{sys}\sc.exe"; Parameters: "stop ConnectLiveWatcher"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete ConnectLiveWatcher"; Flags: runhidden; RunOnceId: "DeleteService"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLiveAgent.exe"; Flags: runhidden; RunOnceId: "KillAgent"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Agent Outbound"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Watcher Outbound"""; Flags: runhidden

[Code]
// Helper function to verify service presence before sc commands
function ServiceExists(const ServiceName: string): Boolean;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'query ' + ServiceName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := (ResultCode = 0);
end;

// Stop the Watcher service before file copy so the LocalSystem process
// releases its exe lock. Wired via BeforeInstall on the Watcher source line.
procedure StopWatcherService;
var
  ResultCode: Integer;
begin
  if ServiceExists('ConnectLiveWatcher') then begin
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop ConnectLiveWatcher', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // Small settle window for SCM to release the file handle.
    Sleep(1500);
  end;
end;
