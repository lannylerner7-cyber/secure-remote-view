; ConnectLive Remote Agent — Inno Setup script
;
; PREREQUISITE: run `build.bat` at the repo root first — this script consumes
;   agent\dist\ConnectLive.exe and agent\dist\ConnectLiveService.exe
; and bundles BOTH into a single ConnectLiveSetup.exe installer.
;
; Build the installer:
;   iscc agent\packaging\inno\ConnectLiveSetup.iss
;
; Interactive install:  ConnectLiveSetup.exe        (user picks folder)
; Silent install:       ConnectLiveSetup.exe /VERYSILENT
; Override folder:      ConnectLiveSetup.exe /VERYSILENT /DIR="C:\Custom\Path"
;
; No deployment key required — first-boot auto-enrollment.

[Setup]
AppId={{B4E9A1C2-7F3D-4A6E-9C2B-CONNECTLIVE500}}
AppName=ConnectLive Remote Agent
AppVersion=5.0
AppPublisher=ConnectLive
DefaultDirName={autopf}\ConnectLive
DefaultGroupName=ConnectLive
DisableProgramGroupPage=yes
; Show the "Select Destination Location" wizard page so users can pick a folder.
DisableDirPage=no
AllowNoIcons=yes
; Strict Admin Enforcement & Elevation
PrivilegesRequired=admin
OutputBaseFilename=ConnectLiveSetup
Compression=lzma2/ultra
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\ConnectLive.exe
; Auto-close running binaries before upgrade/uninstall
CloseApplications=yes
RestartApplications=no

[Dirs]
; ProgramData directory holds the DPAPI-encrypted device.dat that the Watcher
; writes on first-boot auto-enroll. Fixed location — not tied to {app} so the
; encrypted device token survives reinstalls into a different folder.
; SYSTEM full control (Watcher runs as LocalSystem); Users read+exec so the
; interactive Agent can read shared state.
Name: "{commonappdata}\ConnectLive"; Permissions: owners-full admins-full system-full users-readexec

[Files]
; Single installer bundles BOTH binaries; user-chosen {app} = install folder.
; BeforeInstall on the Watcher line stops the service so the LocalSystem
; process releases its exe lock before Inno copies the new file — CloseApplications
; / Restart Manager does not cover services holding an exe.
Source: "..\..\dist\ConnectLive.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\ConnectLiveService.exe"; DestDir: "{app}"; Flags: ignoreversion; BeforeInstall: StopWatcherService

[Run]
; 1. Clean up any existing service instance prior to re-registering (prevents reinstall lockups).
;    Restore a writable ACL first in case a prior install hardened it.
Filename: "{sys}\sc.exe"; Parameters: "sdset ConnectLiveWatcher D:(A;;GA;;;SY)(A;;GA;;;BA)"; Flags: runhidden; Check: ServiceExists('ConnectLiveWatcher')
Filename: "{sys}\sc.exe"; Parameters: "stop ConnectLiveWatcher"; Flags: runhidden; Check: ServiceExists('ConnectLiveWatcher')
Filename: "{sys}\sc.exe"; Parameters: "delete ConnectLiveWatcher"; Flags: runhidden; Check: ServiceExists('ConnectLiveWatcher')

; 2. Register the Watcher as a Windows Service (Delayed AutoStart, LocalSystem)
Filename: "{sys}\sc.exe"; Parameters: "create ConnectLiveWatcher binPath= ""{app}\ConnectLiveService.exe"" start= delayed-auto obj= LocalSystem DisplayName= ""ConnectLive Watcher"""; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "description ConnectLiveWatcher ""Maintains ConnectLive agent presence and spawns the interactive worker for remote support sessions."""; Flags: runhidden
; Self-heal restart policy: restart at 5s / 10s / 30s, reset counter after 60s.
Filename: "{sys}\sc.exe"; Parameters: "failure ConnectLiveWatcher reset= 60 actions= restart/5000/restart/10000/restart/30000"; Flags: runhidden

; 3. HARDEN service against accidental deletion / stop from services.msc.
;    SDDL grants full control to LocalSystem (SY) and Administrators (BA);
;    Interactive Users (IU) and Service Users (SU) get read/query only — they
;    cannot stop or delete the Watcher from the panel. Uninstaller relaxes
;    this before removal (see [UninstallRun]).
Filename: "{sys}\sc.exe"; Parameters: "sdset ConnectLiveWatcher ""D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCLCSWRPWPDTLOCRRC;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"""; Flags: runhidden

; 4. Add outbound firewall rules for both Agent and Watcher (HTTPS Port 443)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLive.exe"" protocol=TCP remoteport=443"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Watcher Outbound"" dir=out action=allow program=""{app}\ConnectLiveService.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; 5. Boot the Watcher service immediately post-install — it will auto-enroll
;    against /api/public/agent/enroll and DPAPI-encrypt the resulting token
;    into %ProgramData%\ConnectLive\device.dat. No operator input required.
Filename: "{sys}\sc.exe"; Parameters: "start ConnectLiveWatcher"; Flags: runhidden

[UninstallRun]
; Relax the hardened ACL FIRST so the uninstaller can actually stop/delete
; the service. Order matters: sdset → stop → delete → kill orphaned Agent →
; firewall cleanup. Deleting before killing prevents SCM from auto-restarting
; the Watcher between our stop and delete calls.
Filename: "{sys}\sc.exe"; Parameters: "sdset ConnectLiveWatcher D:(A;;GA;;;SY)(A;;GA;;;BA)"; Flags: runhidden; RunOnceId: "RelaxAcl"
Filename: "{sys}\sc.exe"; Parameters: "stop ConnectLiveWatcher"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete ConnectLiveWatcher"; Flags: runhidden; RunOnceId: "DeleteService"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLive.exe"; Flags: runhidden; RunOnceId: "KillAgent"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Agent Outbound"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Watcher Outbound"""; Flags: runhidden

[UninstallDelete]
; Runtime health file the Watcher writes on every tick; safe to remove.
Type: files; Name: "{commonappdata}\ConnectLive\watcher-health.json"

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
