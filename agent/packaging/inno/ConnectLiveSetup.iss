; ConnectLive Remote Agent — Inno Setup script
;
; PREREQUISITE: run build.ps1 at the repo root first — this script consumes
;   agent\dist\ConnectLive.exe        (the interactive Agent)
;   agent\dist\ConnectLiveService.exe (the Windows Service)
;
; Build:        iscc agent\packaging\inno\ConnectLiveSetup.iss
; Interactive:  ConnectLiveSetup.exe
; Silent (IT):  ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES
; Silent + log: ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /LOG="%TEMP%\connectlive-install.log"
;
; The SCM service name remains "ConnectLiveWatcher" throughout.
; Binary filename: ConnectLiveService.exe.
; The Agent (ConnectLive.exe) never starts, stops, or repairs the service.

[Setup]
AppId={{B4E9A1C2-7F3D-4A6E-9C2B-CONNECTLIVE500}}
AppName=ConnectLive
AppVersion=5.0
AppPublisher=ConnectLive
DefaultDirName={autopf}\ConnectLive
DefaultGroupName=ConnectLive
DisableProgramGroupPage=yes
DisableDirPage=no
AllowNoIcons=yes
PrivilegesRequired=admin
OutputBaseFilename=ConnectLiveSetup
Compression=lzma2/ultra
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64

SetupIconFile=..\..\assets\icon.ico
UninstallDisplayIcon={app}\ConnectLive.exe
UninstallFilesDir={commonappdata}\ConnectLive\Uninstall
CloseApplications=yes
RestartApplications=no

; ── Directories ─────────────────────────────────────────────────────────────

[Dirs]
Name: "{app}";         Permissions: admins-full system-full users-readexec
Name: "{app}\service"; Permissions: admins-full system-full
Name: "{commonappdata}\ConnectLive"; Permissions: authusers-modify admins-full system-full

; ── Files ───────────────────────────────────────────────────────────────────

[Files]
Source: "..\..\dist\ConnectLive.exe";        DestDir: "{app}";         Flags: ignoreversion
Source: "..\..\dist\ConnectLiveService.exe"; DestDir: "{app}\service"; Flags: ignoreversion; BeforeInstall: StopWatcherService

; ── Run — ONLY firewall rules; all sc.exe work happens in [Code] ───────────
; Service creation/start/ACL is done in CurStepChanged(ssPostInstall) AFTER
; files land on disk. Doing it in ssInstall (pre-copy) is why installs were
; failing with "Service did not start correctly": sc.exe start ran against
; a binPath that didn't yet exist.

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound""   dir=out action=allow program=""{app}\ConnectLive.exe""               protocol=TCP remoteport=443"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Service Outbound"" dir=out action=allow program=""{app}\service\ConnectLiveService.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; ── Uninstall ────────────────────────────────────────────────────────────────

[UninstallRun]
Filename: "{sys}\sc.exe";       Parameters: "sdset ConnectLiveWatcher D:(A;;GA;;;SY)(A;;GA;;;BA)"; Flags: runhidden; RunOnceId: "RelaxAcl"
Filename: "{sys}\sc.exe";       Parameters: "stop ConnectLiveWatcher";                              Flags: runhidden; RunOnceId: "StopService"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLiveService.exe";                        Flags: runhidden; RunOnceId: "KillService"
Filename: "{sys}\sc.exe";       Parameters: "delete ConnectLiveWatcher";                            Flags: runhidden; RunOnceId: "DeleteService"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLive.exe";                               Flags: runhidden; RunOnceId: "KillAgent"
Filename: "{sys}\netsh.exe";    Parameters: "advfirewall firewall delete rule name=""ConnectLive Agent Outbound""";   Flags: runhidden
Filename: "{sys}\netsh.exe";    Parameters: "advfirewall firewall delete rule name=""ConnectLive Service Outbound"""; Flags: runhidden

[UninstallDelete]
Type: files;      Name: "{commonappdata}\ConnectLive\device.dat"
Type: files;      Name: "{commonappdata}\ConnectLive\watcher-health.json"
Type: files;      Name: "{commonappdata}\ConnectLive\stop.flag"
Type: files;      Name: "{commonappdata}\ConnectLive\install.log"
Type: dirifempty; Name: "{commonappdata}\ConnectLive\Uninstall"
Type: dirifempty; Name: "{commonappdata}\ConnectLive"

; ── Pascal [Code] ────────────────────────────────────────────────────────────

[Code]

// ── Logging ──────────────────────────────────────────────────────────────────
// Appends a single line to %ProgramData%\ConnectLive\install.log so the
// compiler debug pane isn't the only source of truth for sc.exe outcomes.

procedure LogLine(const Msg: string);
var
  LogPath: string;
begin
  LogPath := ExpandConstant('{commonappdata}\ConnectLive\install.log');
  ForceDirectories(ExtractFileDir(LogPath));
  SaveStringToFile(LogPath, Msg + #13#10, True);
end;

// Run sc.exe with the given args, log the exit code, return it.
function ScExec(const Args, Label: string): Integer;
var
  RC: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), Args, '', SW_HIDE, ewWaitUntilTerminated, RC);
  LogLine('sc ' + Label + ' exit=' + IntToStr(RC));
  Result := RC;
end;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ServiceExists(const ServiceName: string): Boolean;
var
  RC: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'query ' + ServiceName,
       '', SW_HIDE, ewWaitUntilTerminated, RC);
  Result := (RC = 0);
end;

// sc interrogate returns 0 ONLY for a genuinely Running service.
// sc query returns 0 even for stopped/registered-but-not-running services.
function IsServiceRunning(const ServiceName: string): Boolean;
var
  RC: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'interrogate ' + ServiceName,
       '', SW_HIDE, ewWaitUntilTerminated, RC);
  Result := (RC = 0);
end;

// Called by BeforeInstall on ConnectLiveService.exe — stops the service
// so SCM releases the exe lock before Inno overwrites the file.
procedure StopWatcherService;
begin
  if ServiceExists('ConnectLiveWatcher') then
  begin
    LogLine('--- pre-install stop ---');
    ScExec('sdset ConnectLiveWatcher D:(A;;GA;;;SY)(A;;GA;;;BA)', 'sdset(relax)');
    ScExec('stop ConnectLiveWatcher', 'stop(preinstall)');
    Sleep(2000);
  end;
end;

// ── Service setup (called from CurStepChanged AFTER files are on disk) ───────

procedure SetupWatcherService;
var
  BinPath: string;
  RC: Integer;
begin
  LogLine('--- SetupWatcherService @ ' + GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' ---');

  BinPath := ExpandConstant('{app}') + '\service\ConnectLiveService.exe';
  LogLine('binPath=' + BinPath);

  if not FileExists(BinPath) then
  begin
    LogLine('ERROR: service binary missing at binPath — aborting service setup');
    Exit;
  end;

  // Remove any stale registration from a previous install
  if ServiceExists('ConnectLiveWatcher') then
  begin
    ScExec('stop ConnectLiveWatcher', 'stop(stale)');
    Sleep(1500);
    ScExec('delete ConnectLiveWatcher', 'delete(stale)');
    Sleep(1000);
  end;

  // Register as LocalSystem — mandatory for WTSQueryUserToken / CreateProcessAsUser.
  // BinPath is built in Pascal so quoting survives paths containing spaces
  // (e.g. "C:\Program Files\ConnectLive\service\...").
  ScExec(
    'create ConnectLiveWatcher binPath= "' + BinPath + '" start= delayed-auto obj= LocalSystem DisplayName= "ConnectLive Service"',
    'create');

  ScExec(
    'description ConnectLiveWatcher "Maintains ConnectLive agent presence and spawns the interactive worker for remote support sessions."',
    'description');

  // Self-heal: restart at 5 s / 10 s / 30 s; reset counter after 60 s
  ScExec(
    'failure ConnectLiveWatcher reset= 60 actions= restart/5000/restart/10000/restart/30000',
    'failure');

  // Harden ACL: SYSTEM + Admins full control; IU/SU read/query only
  ScExec(
    'sdset ConnectLiveWatcher "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCLCSWRPWPDTLOCRRC;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"',
    'sdset(harden)');

  // Start — triggers first-boot auto-enrollment with the backend.
  // Retry once on failure to absorb transient SCM contention.
  RC := ScExec('start ConnectLiveWatcher', 'start#1');
  if RC <> 0 then
  begin
    Sleep(2000);
    ScExec('start ConnectLiveWatcher', 'start#2');
  end;
end;

// ── Main lifecycle hook ───────────────────────────────────────────────────────
// ssInstall fires BEFORE [Files] copy — registering the service there
// pointed sc.exe at a binary that didn't exist yet, which is exactly why
// "ConnectLive Service did not start correctly" fired every install.
// ssPostInstall fires AFTER file copy, so the binary is on disk and sc.exe
// can actually launch it.

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    SetupWatcherService;

    // Give the service a moment to fully initialise.
    Sleep(4000);

    // sc interrogate — only returns 0 for a genuinely Running service.
    if not IsServiceRunning('ConnectLiveWatcher') then
    begin
      LogLine('POST-CHECK: service is NOT running');
      if not WizardSilent() then
        MsgBox(
          'Warning: ConnectLive Service did not start correctly.' + #13#10 +
          'The files were installed but the background service is not running.' + #13#10 +
          'Please run ConnectLiveSetup.exe again, or contact your administrator.' + #13#10 +
          #13#10 +
          'For details, see:' + #13#10 +
          '%ProgramData%\ConnectLive\install.log' + #13#10 +
          'To verify: open services.msc and look for "ConnectLive Service".',
          mbError, MB_OK);
    end
    else
      LogLine('POST-CHECK: service is Running — install OK');
  end;
end;
