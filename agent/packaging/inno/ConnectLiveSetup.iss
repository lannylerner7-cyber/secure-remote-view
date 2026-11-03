; ConnectLive: explicit foreground enrollment; no installer-created autorun.
; Per-user installs support signed idle updates. All-users installs stay IT-managed.
#ifndef AppVer
  #define AppVer "1.10.1"
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
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputBaseFilename=ConnectLiveSetup
OutputDir=..\..\dist
Compression=lzma2/ultra
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
SetupIconFile=..\..\assets\icon.ico
UninstallDisplayIcon={app}\ConnectLive.exe
CloseApplications=yes
RestartApplications=no

[Files]
Source: "..\..\dist\ConnectLive.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\ConnectLiveWatch.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\ConnectLiveUpdate.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\ConnectLive"; Filename: "{app}\ConnectLive.exe"

[Run]
; Foreground launch exposes pairing and the separate startup/recovery choice.
; A silent install copies files only; it cannot invent per-user authorization.
Filename: "{app}\ConnectLive.exe"; Flags: nowait postinstall skipifsilent shellexec runasoriginaluser

[UninstallRun]
; No process-name-wide kill: local withdrawal is handled by the user's Agent.
Filename: "{app}\ConnectLive.exe"; Parameters: "/uninstall"; Flags: runhidden; RunOnceId: "DisableLocalAccess"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""ConnectLiveAgent"""; Flags: runhidden; RunOnceId: "RemoveLegacyLogon"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""ConnectLiveWatch"""; Flags: runhidden; RunOnceId: "RemoveLegacyWatch"

[Code]
function InitializeSetup: Boolean;
var
  LegacyKey: String;
begin
  Result := True;
  LegacyKey := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{B4E9A1C2-7F3D-4A6E-9C2B-CONNECTLIVE500}_is1';
  if (not IsAdminInstallMode) and
     (RegKeyExists(HKLM64, LegacyKey) or RegKeyExists(HKLM64, 'SOFTWARE\ConnectLive')) then
  begin
    MsgBox('An all-users installation already exists. Upgrade it in all-users mode or with the managed MSI. Do not create a second Agent installation.', mbError, MB_OK);
    Result := False;
  end;
end;
