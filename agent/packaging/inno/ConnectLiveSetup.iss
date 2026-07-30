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

const
  SC_MANAGER_CONNECT = $0001;
  SC_MANAGER_CREATE_SERVICE = $0002;
  SERVICE_QUERY_STATUS = $0004;
  SERVICE_START = $0010;
  SERVICE_STOP = $0020;
  DELETE_ACCESS = $00010000;
  SERVICE_WIN32_OWN_PROCESS = $00000010;
  SERVICE_AUTO_START = $00000002;
  SERVICE_ERROR_NORMAL = $00000001;
  SERVICE_CONTROL_STOP = $00000001;
  SERVICE_STOPPED = $00000001;
  SERVICE_START_PENDING = $00000002;
  SERVICE_STOP_PENDING = $00000003;
  SERVICE_RUNNING = $00000004;
  ERROR_SERVICE_DOES_NOT_EXIST = 1060;
  ERROR_SERVICE_ALREADY_RUNNING = 1056;

type
  TServiceStatus = record
    ServiceType: Cardinal;
    CurrentState: Cardinal;
    ControlsAccepted: Cardinal;
    Win32ExitCode: Cardinal;
    ServiceSpecificExitCode: Cardinal;
    CheckPoint: Cardinal;
    WaitHint: Cardinal;
  end;

function OpenSCManager(MachineName, DatabaseName: string; DesiredAccess: Cardinal): THandle;
  external 'OpenSCManagerW@advapi32.dll stdcall';
function CreateService(ScManager: THandle; ServiceName, DisplayName: string;
  DesiredAccess, ServiceType, StartType, ErrorControl: Cardinal;
  BinaryPath, LoadOrderGroup: string; TagId: Cardinal; Dependencies,
  ServiceStartName, Password: string): THandle;
  external 'CreateServiceW@advapi32.dll stdcall';
function OpenService(ScManager: THandle; ServiceName: string;
  DesiredAccess: Cardinal): THandle;
  external 'OpenServiceW@advapi32.dll stdcall';
function StartService(Service: THandle; NumServiceArgs: Cardinal;
  ServiceArgVectors: Cardinal): Boolean;
  external 'StartServiceW@advapi32.dll stdcall';
function ControlService(Service: THandle; Control: Cardinal;
  var Status: TServiceStatus): Boolean;
  external 'ControlService@advapi32.dll stdcall';
function QueryServiceStatus(Service: THandle; var Status: TServiceStatus): Boolean;
  external 'QueryServiceStatus@advapi32.dll stdcall';
function DeleteService(Service: THandle): Boolean;
  external 'DeleteService@advapi32.dll stdcall';
function CloseServiceHandle(ScObject: THandle): Boolean;
  external 'CloseServiceHandle@advapi32.dll stdcall';
function GetLastError(): Cardinal;
  external 'GetLastError@kernel32.dll stdcall';

var
  ServiceFailureDetail: string;

procedure LogLine(const Msg: string);
var
  LogPath: string;
begin
  LogPath := ExpandConstant('{commonappdata}\ConnectLive\install.log');
  ForceDirectories(ExtractFileDir(LogPath));
  SaveStringToFile(LogPath,
    GetDateTimeString('yyyy-mm-dd hh:nn:ss.zzz', '-', ':') + ' ' + Msg + #13#10, True);
end;

function ErrorText(const ErrorCode: Cardinal): string;
begin
  Result := IntToStr(ErrorCode) + ' (' + SysErrorMessage(ErrorCode) + ')';
end;

function StateText(const State: Cardinal): string;
begin
  case State of
    SERVICE_STOPPED: Result := 'STOPPED';
    SERVICE_START_PENDING: Result := 'START_PENDING';
    SERVICE_STOP_PENDING: Result := 'STOP_PENDING';
    SERVICE_RUNNING: Result := 'RUNNING';
  else
    Result := 'STATE_' + IntToStr(State);
  end;
end;

function ScExecChecked(const Args, LabelText: string): Boolean;
var
  RC: Integer;
begin
  RC := -1;
  Result := Exec(ExpandConstant('{sys}\sc.exe'), Args, '', SW_HIDE,
    ewWaitUntilTerminated, RC) and (RC = 0);
  LogLine(LabelText + ': exit=' + IntToStr(RC));
end;

function WaitForServiceState(const Service: THandle; DesiredState: Cardinal;
  Attempts: Integer; var Status: TServiceStatus): Boolean;
var
  I: Integer;
  ErrorCode: Cardinal;
begin
  Result := False;
  for I := 1 to Attempts do
  begin
    if not QueryServiceStatus(Service, Status) then
    begin
      ErrorCode := GetLastError();
      ServiceFailureDetail := 'QueryServiceStatus failed: ' + ErrorText(ErrorCode);
      LogLine(ServiceFailureDetail);
      Exit;
    end;
    LogLine('service state=' + StateText(Status.CurrentState) +
      ' win32_exit=' + IntToStr(Status.Win32ExitCode) +
      ' service_exit=' + IntToStr(Status.ServiceSpecificExitCode) +
      ' checkpoint=' + IntToStr(Status.CheckPoint));
    if Status.CurrentState = DesiredState then
    begin
      Result := True;
      Exit;
    end;
    if (DesiredState = SERVICE_RUNNING) and (Status.CurrentState = SERVICE_STOPPED) then
      Exit;
    Sleep(500);
  end;
end;

function WaitForServiceDeletion(const Manager: THandle; Attempts: Integer): Boolean;
var
  I: Integer;
  Probe: THandle;
  ErrorCode: Cardinal;
begin
  Result := False;
  for I := 1 to Attempts do
  begin
    Probe := OpenService(Manager, 'ConnectLiveWatcher', SERVICE_QUERY_STATUS);
    if Probe = 0 then
    begin
      ErrorCode := GetLastError();
      if ErrorCode = ERROR_SERVICE_DOES_NOT_EXIST then
      begin
        LogLine('service deletion: registration is gone');
        Result := True;
        Exit;
      end;
      LogLine('service deletion probe: ' + ErrorText(ErrorCode));
    end
    else
    begin
      CloseServiceHandle(Probe);
      LogLine('service deletion: waiting for SCM to release registration');
    end;
    Sleep(500);
  end;
  ServiceFailureDetail := 'Timed out waiting for the old service registration to be deleted.';
  LogLine(ServiceFailureDetail);
end;

function RemoveWatcherService(): Boolean;
var
  Manager, Service: THandle;
  Status: TServiceStatus;
  ErrorCode: Cardinal;
  DeleteAccepted: Boolean;
begin
  Result := False;
  DeleteAccepted := False;
  Manager := OpenSCManager('', '', SC_MANAGER_CONNECT);
  if Manager = 0 then
  begin
    ErrorCode := GetLastError();
    ServiceFailureDetail := 'OpenSCManager(remove) failed: ' + ErrorText(ErrorCode);
    LogLine(ServiceFailureDetail);
    Exit;
  end;
  try
    Service := OpenService(Manager, 'ConnectLiveWatcher',
      SERVICE_QUERY_STATUS or SERVICE_STOP or DELETE_ACCESS);
    if Service = 0 then
    begin
      ErrorCode := GetLastError();
      if ErrorCode = ERROR_SERVICE_DOES_NOT_EXIST then
      begin
        LogLine('existing service: not present');
        Result := True;
      end
      else
      begin
        ServiceFailureDetail := 'OpenService(remove) failed: ' + ErrorText(ErrorCode);
        LogLine(ServiceFailureDetail);
      end;
      Exit;
    end;
    try
      if QueryServiceStatus(Service, Status) and (Status.CurrentState <> SERVICE_STOPPED) then
      begin
        if not ControlService(Service, SERVICE_CONTROL_STOP, Status) then
        begin
          ErrorCode := GetLastError();
          LogLine('ControlService(STOP) returned ' + ErrorText(ErrorCode));
        end
        else
          WaitForServiceState(Service, SERVICE_STOPPED, 40, Status);
      end;
      if not DeleteService(Service) then
      begin
        ErrorCode := GetLastError();
        ServiceFailureDetail := 'DeleteService failed: ' + ErrorText(ErrorCode);
        LogLine(ServiceFailureDetail);
        Exit;
      end;
      LogLine('DeleteService: accepted by SCM');
      DeleteAccepted := True;
    finally
      CloseServiceHandle(Service);
    end;
    if DeleteAccepted then
      Result := WaitForServiceDeletion(Manager, 40);
  finally
    CloseServiceHandle(Manager);
  end;
end;

procedure StopWatcherService;
begin
  LogLine('--- pre-copy service removal ---');
  ScExecChecked('sdset ConnectLiveWatcher D:(A;;GA;;;SY)(A;;GA;;;BA)',
    'relax existing service ACL');
  if RemoveWatcherService() then
    Sleep(1000);
end;

function SetupWatcherService(): Boolean;
var
  Manager, Service: THandle;
  Status: TServiceStatus;
  BinPath, StoredBinPath: string;
  ErrorCode: Cardinal;
begin
  Result := False;
  ServiceFailureDetail := '';
  BinPath := ExpandConstant('{app}\service\ConnectLiveService.exe');
  StoredBinPath := '"' + BinPath + '"';
  LogLine('--- service registration ---');
  LogLine('install directory=' + ExpandConstant('{app}'));
  LogLine('binary path=' + BinPath);
  LogLine('stored image path=' + StoredBinPath);
  LogLine('service account=LocalSystem; start=Automatic (Delayed Start)');

  if not FileExists(BinPath) then
  begin
    ServiceFailureDetail := 'Service binary is missing: ' + BinPath;
    LogLine(ServiceFailureDetail);
    Exit;
  end;

  if not RemoveWatcherService() then Exit;
  Manager := OpenSCManager('', '', SC_MANAGER_CONNECT or SC_MANAGER_CREATE_SERVICE);
  if Manager = 0 then
  begin
    ErrorCode := GetLastError();
    ServiceFailureDetail := 'OpenSCManager(create) failed: ' + ErrorText(ErrorCode);
    LogLine(ServiceFailureDetail);
    Exit;
  end;
  try
    Service := CreateService(Manager, 'ConnectLiveWatcher', 'ConnectLive Service',
      SERVICE_QUERY_STATUS or SERVICE_START or SERVICE_STOP or DELETE_ACCESS,
      SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
      StoredBinPath, '', 0, '', 'LocalSystem', '');
    if Service = 0 then
    begin
      ErrorCode := GetLastError();
      ServiceFailureDetail := 'CreateService failed: ' + ErrorText(ErrorCode);
      LogLine(ServiceFailureDetail);
      Exit;
    end;
    try
      LogLine('CreateService: success');
      if not ScExecChecked('config ConnectLiveWatcher start= delayed-auto',
        'configure delayed-auto') then Exit;
      if not ScExecChecked(
        'description ConnectLiveWatcher "Maintains ConnectLive agent presence and spawns the interactive worker for remote support sessions."',
        'configure description') then Exit;
      if not ScExecChecked(
        'failure ConnectLiveWatcher reset= 60 actions= restart/5000/restart/10000/restart/30000',
        'configure recovery') then Exit;
      if not ScExecChecked(
        'sdset ConnectLiveWatcher "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"',
        'configure service ACL') then Exit;

      if not StartService(Service, 0, 0) then
      begin
        ErrorCode := GetLastError();
        if ErrorCode <> ERROR_SERVICE_ALREADY_RUNNING then
        begin
          ServiceFailureDetail := 'StartService failed: ' + ErrorText(ErrorCode);
          LogLine(ServiceFailureDetail);
          Exit;
        end;
      end;
      LogLine('StartService: accepted by SCM');
      Status.CurrentState := 0;
      Status.Win32ExitCode := 0;
      Status.ServiceSpecificExitCode := 0;
      if not WaitForServiceState(Service, SERVICE_RUNNING, 60, Status) then
      begin
        ServiceFailureDetail := 'Service did not reach RUNNING; final_state=' +
          StateText(Status.CurrentState) + ' win32_exit=' + IntToStr(Status.Win32ExitCode) +
          ' service_exit=' + IntToStr(Status.ServiceSpecificExitCode);
        LogLine(ServiceFailureDetail);
        Exit;
      end;
      Result := True;
      LogLine('service startup: RUNNING');
    finally
      CloseServiceHandle(Service);
    end;
  finally
    CloseServiceHandle(Manager);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    LogLine('=== ConnectLive install ' +
      GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' ===');
    if not SetupWatcherService() then
    begin
      if ServiceFailureDetail = '' then
        ServiceFailureDetail := 'Unknown service-control failure; inspect install.log.';
      if not WizardSilent() then
        MsgBox(
          'Warning: ConnectLive Service did not start correctly.' + #13#10 +
          ServiceFailureDetail + #13#10 + #13#10 +
          'See %ProgramData%\ConnectLive\install.log for details.',
          mbError, MB_OK);
    end;
  end;
end;
