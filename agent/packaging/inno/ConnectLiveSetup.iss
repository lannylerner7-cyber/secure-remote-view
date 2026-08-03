; ConnectLive Agent -- installer (standalone, agent-only)
;
; What this installer does:
;   1. Copies ConnectLive.exe to Program Files\ConnectLive\
;   2. Creates ProgramData\ConnectLive\ with correct permissions
;   3. Adds an outbound HTTPS firewall rule for the Agent
;   4. Registers a per-machine "ConnectLiveAgent" ONLOGON Scheduled Task as the
;      third logon trigger (complements the HKCU Run key + Startup shortcut that
;      the Agent self-heals on launch). The task XML is generated in [Code] with
;      the installed path baked in, then registered via schtasks /XML -- this
;      avoids schtasks /TR inline-quoting bugs with spaced paths + arguments.
;
; There is NO helper service. Wake-after-close is delivered by the SSE stream
; the Agent opens itself on next logon; that channel is dormant while the
; process is dead by design.
;
; Build:    iscc packaging\inno\ConnectLiveSetup.iss
;           iscc packaging\inno\ConnectLiveSetup.iss /DAppVer=1.0.260801.1200
; Install:  ConnectLiveSetup.exe
; Silent:   ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES

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

[Dirs]
; Install folder -- only the Agent binary lives here.
Name: "{app}"; Permissions: admins-full system-full users-readexec
; ProgramData -- device.dat (legacy), install.log. The Agent migrates device.dat
; to %LOCALAPPDATA%\ConnectLive on first launch; this dir stays for install.log
; and any leftover legacy artifacts.
Name: "{commonappdata}\ConnectLive"; Permissions: authusers-modify admins-full system-full

[Tasks]
; The logon Scheduled Task honours this checkbox. Checked by default (and thus
; selected on /VERYSILENT MDM pushes, which is the "always reachable" intent);
; unchecking it skips schtasks registration in RegisterLogonTask. The Agent's
; own StartupSelfHeal (HKCU Run key + Startup shortcut) is unaffected either way.
Name: "autostart"; Description: "Start ConnectLive automatically at logon (recommended)"; GroupDescription: "Startup:"

[Files]
; The Agent binary. AfterInstall triggers the Scheduled Task registration once
; the exe is on disk (the [Code] generates the task XML with this path baked in).
Source: "..\..\dist\ConnectLive.exe"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: RegisterLogonTask

[Run]
; Outbound firewall rule for the Agent (HTTPS only).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLive.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; Launch the Agent after install so the user sees it start.
; /background: no splash, straight into enrollment + heartbeat.
;
; shellexec         -- use ShellExecute (honors the manifest, unlike CreateProcess).
; runasoriginaluser -- launch as the interactive desktop user, NOT the elevated
;                      installer token. The Agent must run in the user's session
;                      so its HKCU Run key writes into the correct hive.
;                      Without this flag an admin-manifested EXE fails with
;                      "CreateProcess failed; code 740 -- requires elevation".
Filename: "{app}\ConnectLive.exe"; Parameters: "/background"; Flags: nowait postinstall skipifsilent shellexec runasoriginaluser

[UninstallRun]
; Remove the logon Scheduled Task first so nothing relaunches the Agent mid-uninstall.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""ConnectLiveAgent"""; Flags: runhidden; RunOnceId: "DelConnectLiveTask"
; Kill the Agent process cleanly.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLive.exe"; Flags: runhidden; RunOnceId: "KillAgent"
; Remove firewall rule.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Agent Outbound"""; Flags: runhidden; RunOnceId: "FwAgent"

[UninstallDelete]
Type: files;      Name: "{app}\ConnectLiveAgentTask.xml"
Type: files;      Name: "{commonappdata}\ConnectLive\device.dat"
Type: files;      Name: "{commonappdata}\ConnectLive\install.log"
Type: dirifempty; Name: "{commonappdata}\ConnectLive"

[Code]
// Registers the ONLOGON Scheduled Task.
//
// WHY GENERATE XML IN CODE (not inline /TR, not a shipped template file):
//  - schtasks /TR quoting is fragile when the exe path has spaces
//    ("C:\Program Files\...") AND an argument (/background). It creates a task
//    that silently FAILS TO LAUNCH at logon. XML with separate <Command> and
//    <Arguments> elements removes all quoting ambiguity.
//  - Building the XML string here (rather than loading a template file and
//    doing in-place replacement) keeps every path variable a plain String until
//    the final write, which encodes it to UTF-16 LE bytes via StringToUtf16LE
//    (see the note there -- SaveStringToFile alone would emit ANSI and schtasks
//    can reject the encoding mismatch).
//
// S-1-5-32-545 = built-in Users group => fires for any interactive logon.
// RunLevel LeastPrivilege = asInvoker (matches the Agent manifest, no UAC).
// Delay PT10S = 10s so the network stack is up before enrollment.
// Arguments /background = MUST stay lowercase to match App.xaml.cs parsing.

// Encodes a Unicode string as UTF-16 LE with a BOM, returned as a raw AnsiString
// byte buffer. Needed because Inno's SaveStringToFile has NO Unicode option --
// its third argument is Append, and it otherwise writes system-ANSI bytes. That
// would produce a file whose bytes are ANSI while the declaration claims UTF-16,
// which schtasks /XML can reject as malformed. Building the exact UTF-16 LE bytes
// here and writing them verbatim (SaveStringToFile leaves an AnsiString's bytes
// untouched) matches the <?xml ... encoding="UTF-16"?> declaration and survives
// a non-ASCII install path. This is the byte-for-byte format schtasks /Query /XML
// itself emits, so it is guaranteed acceptable.
function StringToUtf16LE(const S: String): AnsiString;
var
  I, Code: Integer;
begin
  Result := #$FF#$FE;  // UTF-16 LE byte-order mark
  for I := 1 to Length(S) do
  begin
    Code := Ord(S[I]);
    Result := Result + Chr(Code and $FF) + Chr((Code shr 8) and $FF);
  end;
end;

procedure RegisterLogonTask;
var
  XmlPath, ExePath, Xml, LogPath: String;
  RC: Integer;
  Started: Boolean;
begin
  LogPath := ExpandConstant('{commonappdata}\ConnectLive\install.log');

  // Honour the [Tasks] checkbox. AfterInstall runs unconditionally, so the gate
  // lives here rather than on the [Files] entry.
  if not WizardIsTaskSelected('autostart') then
  begin
    SaveStringToFile(LogPath,
      'schtasks /XML ConnectLiveAgent skipped (autostart task unchecked)' + #13#10, True);
    Exit;
  end;

  ExePath := ExpandConstant('{app}\ConnectLive.exe');
  XmlPath := ExpandConstant('{app}\ConnectLiveAgentTask.xml');

  // Build the task definition with the installed path baked directly in.
  Xml :=
    '<?xml version="1.0" encoding="UTF-16"?>' + #13#10 +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">' + #13#10 +
    '  <RegistrationInfo>' + #13#10 +
    '    <Description>Starts the ConnectLive Agent at user logon.</Description>' + #13#10 +
    '    <URI>\ConnectLiveAgent</URI>' + #13#10 +
    '  </RegistrationInfo>' + #13#10 +
    '  <Triggers>' + #13#10 +
    '    <LogonTrigger>' + #13#10 +
    '      <Enabled>true</Enabled>' + #13#10 +
    '      <Delay>PT10S</Delay>' + #13#10 +
    '    </LogonTrigger>' + #13#10 +
    '  </Triggers>' + #13#10 +
    '  <Principals>' + #13#10 +
    '    <Principal id="Author">' + #13#10 +
    '      <GroupId>S-1-5-32-545</GroupId>' + #13#10 +
    '      <RunLevel>LeastPrivilege</RunLevel>' + #13#10 +
    '    </Principal>' + #13#10 +
    '  </Principals>' + #13#10 +
    '  <Settings>' + #13#10 +
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>' + #13#10 +
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>' + #13#10 +
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>' + #13#10 +
    '    <AllowHardTerminate>true</AllowHardTerminate>' + #13#10 +
    '    <StartWhenAvailable>true</StartWhenAvailable>' + #13#10 +
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>' + #13#10 +
    '    <IdleSettings>' + #13#10 +
    '      <StopOnIdleEnd>false</StopOnIdleEnd>' + #13#10 +
    '      <RestartOnIdle>false</RestartOnIdle>' + #13#10 +
    '    </IdleSettings>' + #13#10 +
    '    <AllowStartOnDemand>true</AllowStartOnDemand>' + #13#10 +
    '    <Enabled>true</Enabled>' + #13#10 +
    '    <Hidden>false</Hidden>' + #13#10 +
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>' + #13#10 +
    '    <WakeToRun>false</WakeToRun>' + #13#10 +
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>' + #13#10 +
    '    <Priority>7</Priority>' + #13#10 +
    '  </Settings>' + #13#10 +
    '  <Actions Context="Author">' + #13#10 +
    '    <Exec>' + #13#10 +
    '      <Command>' + ExePath + '</Command>' + #13#10 +
    '      <Arguments>/background</Arguments>' + #13#10 +
    '    </Exec>' + #13#10 +
    '  </Actions>' + #13#10 +
    '</Task>' + #13#10;

  // schtasks /XML expects a genuine UTF-16 (Unicode) file. Write the bytes the
  // declaration promises -- BOM + UTF-16 LE -- via the helper above. (SaveStringToFile
  // itself has no Unicode mode; passing the raw AnsiString byte buffer writes it
  // verbatim. Third argument False = overwrite, not append.)
  SaveStringToFile(XmlPath, StringToUtf16LE(Xml), False);

  // /Create /F overwrites any prior task; /XML supplies the full definition.
  Started := Exec(ExpandConstant('{sys}\schtasks.exe'),
       '/Create /F /TN "ConnectLiveAgent" /XML "' + XmlPath + '"',
       '', SW_HIDE, ewWaitUntilTerminated, RC);

  if Started then
    SaveStringToFile(LogPath,
      'schtasks /XML ConnectLiveAgent exit=' + IntToStr(RC) + #13#10, True)
  else
    SaveStringToFile(LogPath,
      'schtasks /XML ConnectLiveAgent FAILED to launch (Exec returned false)' + #13#10, True);
end;
