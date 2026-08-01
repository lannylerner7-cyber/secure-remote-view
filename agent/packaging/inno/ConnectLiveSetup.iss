; ConnectLive Agent — installer
;
; What this installer does:
;   1. Copies ConnectLive.exe to Program Files\ConnectLive\
;   2. Creates ProgramData\ConnectLive\ with correct permissions
;   3. Adds outbound firewall rule(s)
;   4. OPTIONALLY installs ConnectLiveUpdater.exe and registers it as a
;      LocalSystem Windows Service (component "updater", off by default).
;      The Updater exists solely so an admin can wake the Agent after the
;      user closed it. The Agent itself never depends on it.
;
; Startup persistence for the Agent is handled by the Agent via its HKCU Run
; key, written after successful first enrollment — not by the installer.
;
; Build:    iscc packaging\inno\ConnectLiveSetup.iss
;           iscc packaging\inno\ConnectLiveSetup.iss /DNoUpdater   (agent only)
;           iscc packaging\inno\ConnectLiveSetup.iss /DAppVer=1.0.260801.1200
; Install:  ConnectLiveSetup.exe
; Silent:   ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES
;           add /COMPONENTS="agent,updater" to include the service silently.

#ifndef AppVer
  #define AppVer "5.0"
#endif

[Setup]
AppId={{B4E9A1C2-7F3D-4A6E-9C2B-CONNECTLIVE500}}
AppName=ConnectLive
AppVersion={#AppVer}
AppPublisher=ConnectLive
DefaultDirName={autopf}\ConnectLive
DefaultGroupName=ConnectLive
DisableProgramGroupPage=yes
DisableDirPage=no
AllowNoIcons=yes
PrivilegesRequired=admin
OutputBaseFilename=ConnectLiveSetup
OutputDir=..\..\dist
Compression=lzma2/ultra
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
SetupIconFile=..\..\assets\icon.ico
UninstallDisplayIcon={app}\ConnectLive.exe
CloseApplications=yes
RestartApplications=no

[Types]
Name: "full";    Description: "Full install (Agent + background Updater service)"
Name: "compact"; Description: "Agent only (recommended)"
Name: "custom";  Description: "Custom"; Flags: iscustom

[Components]
Name: "agent";   Description: "ConnectLive Agent (required)"; Types: full compact custom; Flags: fixed
#ifndef NoUpdater
Name: "updater"; Description: "Background Updater service (LocalSystem) — lets an admin wake the Agent after it has been closed"; Types: full
#endif

[Dirs]
; Install folder — only the binaries live here.
Name: "{app}"; Permissions: admins-full system-full users-readexec
; ProgramData — device.dat, stop.flag, install.log.
; authusers-modify: Agent (running as logged-in user) reads device.dat,
; writes stop.flag.
Name: "{commonappdata}\ConnectLive"; Permissions: authusers-modify admins-full system-full

[Files]
Source: "..\..\dist\ConnectLive.exe"; DestDir: "{app}"; Flags: ignoreversion; Components: agent
#ifndef NoUpdater
Source: "..\..\dist\ConnectLiveUpdater.exe"; DestDir: "{app}"; Flags: ignoreversion; Components: updater
#endif

[Run]
; Outbound firewall rule for the Agent (HTTPS only).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLive.exe"" protocol=TCP remoteport=443"; Flags: runhidden; Components: agent
#ifndef NoUpdater
; Outbound firewall rule for the Updater service (HTTPS only).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Updater Outbound"" dir=out action=allow program=""{app}\ConnectLiveUpdater.exe"" protocol=TCP remoteport=443"; Flags: runhidden; Components: updater
#endif

; Launch the Agent after install so the user sees it start.
; /background: goes straight to tray, no splash, begins enrollment + heartbeat.
;
; shellexec        — use ShellExecute (honors any manifest, unlike CreateProcess).
; runasoriginaluser — launch as the interactive desktop user, NOT the elevated
;                     installer token. Tray apps must run in the user's session
;                     so their HKCU Run key writes into the correct hive.
;                     Without this flag, an admin-manifested EXE fails with
;                     "CreateProcess failed; code 740 — requires elevation".
Filename: "{app}\ConnectLive.exe"; Parameters: "/background"; Flags: nowait postinstall skipifsilent shellexec runasoriginaluser; Components: agent

[UninstallRun]
; Kill the Agent process cleanly.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLive.exe"; Flags: runhidden; RunOnceId: "KillAgent"
#ifndef NoUpdater
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLiveUpdater.exe"; Flags: runhidden; RunOnceId: "KillUpdater"
#endif
; Remove firewall rules.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Agent Outbound"""; Flags: runhidden; RunOnceId: "FwAgent"
#ifndef NoUpdater
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Updater Outbound"""; Flags: runhidden; RunOnceId: "FwUpdater"
#endif

[UninstallDelete]
Type: files;      Name: "{commonappdata}\ConnectLive\device.dat"
Type: files;      Name: "{commonappdata}\ConnectLive\stop.flag"
Type: files;      Name: "{commonappdata}\ConnectLive\install.log"
Type: dirifempty; Name: "{commonappdata}\ConnectLive"

[Code]
{
  Service registration uses the native Service Control Manager API rather than
  sc.exe. sc.exe swallows the real Win32 error behind a localized string and a
  generic exit code, which is what made earlier "did not start correctly"
  failures impossible to diagnose. Everything here is logged to
  %ProgramData%\ConnectLive\install.log with the exact Win32 error number.
}

const
  SC_MANAGER_ALL_ACCESS   = $000F003F;
  SERVICE_ALL_ACCESS      = $000F01FF;
  SERVICE_WIN32_OWN_PROCESS = $00000010;
  SERVICE_AUTO_START      = $00000002;
  SERVICE_ERROR_NORMAL    = $00000001;
  SERVICE_CONTROL_STOP    = $00000001;
  SERVICE_RUNNING         = $00000004;
  SERVICE_STOPPED         = $00000001;
  SVC_NAME                = 'ConnectLiveUpdater';
  SVC_DISPLAY             = 'ConnectLive Updater';

type
  TServiceStatus = record
    dwServiceType: Cardinal;
    dwCurrentState: Cardinal;
    dwControlsAccepted: Cardinal;
    dwWin32ExitCode: Cardinal;
    dwServiceSpecificExitCode: Cardinal;
    dwCheckPoint: Cardinal;
    dwWaitHint: Cardinal;
  end;

function OpenSCManager(lpMachineName, lpDatabaseName: string; dwDesiredAccess: Cardinal): THandle;
  external 'OpenSCManagerW@advapi32.dll stdcall';
function OpenService(hSCManager: THandle; lpServiceName: string; dwDesiredAccess: Cardinal): THandle;
  external 'OpenServiceW@advapi32.dll stdcall';
function CreateService(hSCManager: THandle; lpServiceName, lpDisplayName: string;
  dwDesiredAccess, dwServiceType, dwStartType, dwErrorControl: Cardinal;
  lpBinaryPathName: string; lpLoadOrderGroup: Cardinal; lpdwTagId: Cardinal;
  lpDependencies, lpServiceStartName, lpPassword: Cardinal): THandle;
  external 'CreateServiceW@advapi32.dll stdcall';
function StartService(hService: THandle; dwNumServiceArgs: Cardinal; lpServiceArgVectors: Cardinal): Boolean;
  external 'StartServiceW@advapi32.dll stdcall';
function ControlService(hService: THandle; dwControl: Cardinal; var lpServiceStatus: TServiceStatus): Boolean;
  external 'ControlService@advapi32.dll stdcall';
function QueryServiceStatus(hService: THandle; var lpServiceStatus: TServiceStatus): Boolean;
  external 'QueryServiceStatus@advapi32.dll stdcall';
function DeleteService(hService: THandle): Boolean;
  external 'DeleteService@advapi32.dll stdcall';
function CloseServiceHandle(hSCObject: THandle): Boolean;
  external 'CloseServiceHandle@advapi32.dll stdcall';
function GetLastError(): Cardinal;
  external 'GetLastError@kernel32.dll stdcall';

procedure LogLine(const S: string);
var
  Dir, Path: string;
  Existing: AnsiString;
begin
  Dir := ExpandConstant('{commonappdata}\ConnectLive');
  if not DirExists(Dir) then
    ForceDirectories(Dir);
  Path := Dir + '\install.log';
  Existing := '';
  LoadStringFromFile(Path, Existing);
  SaveStringToFile(Path, Existing + AnsiString(GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + '  ' + S + #13#10), False);
end;

function UpdaterSelected(): Boolean;
begin
#ifdef NoUpdater
  Result := False;
#else
  Result := WizardIsComponentSelected('updater');
#endif
end;

{ Registers + starts the Updater service. Returns '' on success or a
  human-readable failure reason. }
function InstallUpdaterService(): string;
var
  hSCM, hSvc: THandle;
  BinPath: string;
  Status: TServiceStatus;
  Err: Cardinal;
  I: Integer;
begin
  Result := '';
  BinPath := '"' + ExpandConstant('{app}\ConnectLiveUpdater.exe') + '"';

  hSCM := OpenSCManager('', '', SC_MANAGER_ALL_ACCESS);
  if hSCM = 0 then begin
    Err := GetLastError();
    Result := 'OpenSCManager failed (Win32 ' + IntToStr(Err) + ')';
    LogLine('ERROR ' + Result);
    Exit;
  end;

  try
    { Reuse an existing registration if the service is already there. }
    hSvc := OpenService(hSCM, SVC_NAME, SERVICE_ALL_ACCESS);
    if hSvc = 0 then begin
      hSvc := CreateService(hSCM, SVC_NAME, SVC_DISPLAY, SERVICE_ALL_ACCESS,
        SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
        BinPath, 0, 0, 0, 0, 0);   { lpServiceStartName = NULL => LocalSystem }
      if hSvc = 0 then begin
        Err := GetLastError();
        Result := 'CreateService failed (Win32 ' + IntToStr(Err) + ')';
        LogLine('ERROR ' + Result + ' bin=' + BinPath);
        Exit;
      end;
      LogLine('Service created as LocalSystem: ' + BinPath);
    end else
      LogLine('Service already registered - reusing');

    try
      if not StartService(hSvc, 0, 0) then begin
        Err := GetLastError();
        { 1056 = already running }
        if Err <> 1056 then begin
          Result := 'StartService failed (Win32 ' + IntToStr(Err) + ')';
          LogLine('ERROR ' + Result);
          Exit;
        end;
      end;

      { Poll for RUNNING - starting is asynchronous. }
      for I := 1 to 20 do begin
        if not QueryServiceStatus(hSvc, Status) then Break;
        if Status.dwCurrentState = SERVICE_RUNNING then begin
          LogLine('Service is RUNNING');
          Exit;
        end;
        Sleep(500);
      end;

      Result := 'Service did not reach RUNNING (state ' + IntToStr(Status.dwCurrentState) +
                ', exit code ' + IntToStr(Status.dwWin32ExitCode) + ')';
      LogLine('ERROR ' + Result);
    finally
      CloseServiceHandle(hSvc);
    end;
  finally
    CloseServiceHandle(hSCM);
  end;
end;

procedure RemoveUpdaterService();
var
  hSCM, hSvc: THandle;
  Status: TServiceStatus;
  I: Integer;
begin
  hSCM := OpenSCManager('', '', SC_MANAGER_ALL_ACCESS);
  if hSCM = 0 then Exit;
  try
    hSvc := OpenService(hSCM, SVC_NAME, SERVICE_ALL_ACCESS);
    if hSvc = 0 then Exit;   { never installed - nothing to undo }
    try
      if QueryServiceStatus(hSvc, Status) then
        if Status.dwCurrentState <> SERVICE_STOPPED then begin
          ControlService(hSvc, SERVICE_CONTROL_STOP, Status);
          for I := 1 to 20 do begin
            if not QueryServiceStatus(hSvc, Status) then Break;
            if Status.dwCurrentState = SERVICE_STOPPED then Break;
            Sleep(500);
          end;
        end;
      DeleteService(hSvc);
    finally
      CloseServiceHandle(hSvc);
    end;
  finally
    CloseServiceHandle(hSCM);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Failure: string;
begin
  if CurStep = ssPostInstall then begin
    LogLine('Install completed - components: ' + WizardSelectedComponents(False));
    if UpdaterSelected() then begin
      Failure := InstallUpdaterService();
      if Failure <> '' then
        SuppressibleMsgBox(
          'ConnectLive installed, but the optional Updater service could not start.' + #13#10#13#10 +
          Failure + #13#10#13#10 +
          'The Agent itself works normally; only remote wake-after-close is unavailable.' + #13#10 +
          'Details: ' + ExpandConstant('{commonappdata}\ConnectLive\install.log'),
          mbInformation, MB_OK, IDOK);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveUpdaterService();
end;
