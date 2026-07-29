; ConnectLive Remote Agent — Inno Setup script
;
; Build:
;   iscc agent\packaging\inno\ConnectLiveSetup.iss
;
; Silent install with deployment key:
;   ConnectLiveSetup.exe /VERYSILENT /DEPLOYMENT_KEY="your-key-here"
;
; Or drop a plain-text `deployment.key` file next to the installer .exe
; and the [Code] block will copy it into %ProgramData%\ConnectLive\.
;
; Expects `build.bat` (or `agent\build.ps1`) to have populated
; agent\dist\ConnectLiveAgent.exe and agent\dist\ConnectLiveWatcher.exe first.

[Setup]
AppName=ConnectLive Remote Agent
AppVersion=1.0
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
; Explicitly create ProgramData directory with elevated permissions
Name: "{commonappdata}\ConnectLive"; Permissions: owners-full admins-full system-full

[Files]
; Pull single-file binaries from build output (this .iss lives in agent\packaging\inno\)
Source: "..\..\dist\ConnectLiveAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\ConnectLiveWatcher.exe"; DestDir: "{app}"; Flags: ignoreversion

[Run]
; 1. Clean up any existing service instance prior to re-registering (prevents reinstall lockups)
Filename: "{sys}\sc.exe"; Parameters: "stop ConnectLiveWatcher"; Flags: runhidden; Check: ServiceExists('ConnectLiveWatcher')
Filename: "{sys}\sc.exe"; Parameters: "delete ConnectLiveWatcher"; Flags: runhidden; Check: ServiceExists('ConnectLiveWatcher')

; 2. Register the Watcher as a Windows Service (Delayed AutoStart, LocalSystem)
Filename: "{sys}\sc.exe"; Parameters: "create ConnectLiveWatcher binPath= ""{app}\ConnectLiveWatcher.exe"" start= delayed-auto obj= LocalSystem"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "description ConnectLiveWatcher ""Monitors and maintains the ConnectLive remote agent connection."""; Flags: runhidden

; 3. Add outbound firewall rules for both Agent and Watcher (HTTPS Port 443)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLiveAgent.exe"" protocol=TCP remoteport=443"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Watcher Outbound"" dir=out action=allow program=""{app}\ConnectLiveWatcher.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; 4. Boot the Watcher service immediately post-install
Filename: "{sys}\sc.exe"; Parameters: "start ConnectLiveWatcher"; Flags: runhidden

[UninstallRun]
; Stop service, kill running agent process, delete service, and clean firewall rules
Filename: "{sys}\sc.exe"; Parameters: "stop ConnectLiveWatcher"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLiveAgent.exe"; Flags: runhidden; RunOnceId: "KillAgent"
Filename: "{sys}\sc.exe"; Parameters: "delete ConnectLiveWatcher"; Flags: runhidden; RunOnceId: "DeleteService"
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

// Helper function to parse custom command line switches (/DEPLOYMENT_KEY="xxx")
function GetCommandLineParam(ParamName: String): String;
var
  CmdLine: String;
  ParamPos, ParamEnd: Integer;
begin
  Result := '';
  CmdLine := GetCmdTail;
  ParamPos := Pos(UpperCase(ParamName) + '=', UpperCase(CmdLine));
  if ParamPos > 0 then begin
    ParamPos := ParamPos + Length(ParamName) + 1;
    if Copy(CmdLine, ParamPos, 1) = '"' then begin
      ParamPos := ParamPos + 1;
      ParamEnd := PosEx('"', CmdLine, ParamPos);
    end else begin
      ParamEnd := PosEx(' ', CmdLine, ParamPos);
    end;
    if ParamEnd = 0 then ParamEnd := Length(CmdLine) + 1;
    Result := Copy(CmdLine, ParamPos, ParamEnd - ParamPos);
  end;
end;

// Key provisioning logic executed immediately after file extraction
procedure CurStepChanged(CurStep: TSetupStep);
var
  DeploymentKey: String;
  TargetDir, TargetFilePath, LocalSidecarKey: String;
begin
  if CurStep = ssPostInstall then begin
    TargetDir := ExpandConstant('{commonappdata}\ConnectLive');
    TargetFilePath := TargetDir + '\deployment.key';

    if not DirExists(TargetDir) then
      CreateDir(TargetDir);

    // Method 1: Check for CLI switch (/DEPLOYMENT_KEY="xxx")
    DeploymentKey := GetCommandLineParam('/DEPLOYMENT_KEY');

    if DeploymentKey <> '' then begin
      SaveStringToFile(TargetFilePath, DeploymentKey, False);
    end
    else begin
      // Method 2: Fallback — Check for a "deployment.key" file placed next to the installer .exe
      LocalSidecarKey := ExpandConstant('{src}\deployment.key');
      if FileExists(LocalSidecarKey) then begin
        FileCopy(LocalSidecarKey, TargetFilePath, False);
      end;
    end;
  end;
end;
