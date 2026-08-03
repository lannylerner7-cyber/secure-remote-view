; ConnectLive Agent — installer (standalone, agent-only)
;
; What this installer does:
;   1. Copies ConnectLive.exe to Program Files\ConnectLive\
;   2. Creates ProgramData\ConnectLive\ with correct permissions
;   3. Adds an outbound HTTPS firewall rule for the Agent
;   4. Registers FOUR autostart triggers, all launching the Agent with the
;      identical lowercase /background flag:
;        - HKCU\...\Run
;        - HKLM\...\Run
;        - All-users Startup folder shortcut
;        - Per-machine ONLOGON Scheduled Task
;   5. Records install path and version under HKLM\Software\ConnectLive
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
CloseApplications=force
RestartApplications=no

[Tasks]
Name: autostart; Description: Start ConnectLive automatically at Windows logon; GroupDescription: Startup; Flags: checkedonce

[Dirs]
; Install folder — only the Agent binary lives here.
Name: "{app}"; Permissions: admins-full system-full users-readexec
; ProgramData — device.dat (legacy), install.log. The Agent migrates device.dat
; to %LOCALAPPDATA%\ConnectLive on first launch; this dir stays for install.log
; and any leftover legacy artifacts.
Name: "{commonappdata}\ConnectLive"; Permissions: authusers-modify admins-full system-full

[Files]
Source: "..\..\dist\ConnectLive.exe"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; 1. HKCU Run — written into the interactive installing user's hive.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "ConnectLive"; \
  ValueData: "\"{app}\ConnectLive.exe\" /background"; \
  Tasks: autostart; Flags: uninsdeletevalue

; 2. HKLM Run — machine-wide fallback so a fresh user profile on the same box
;    still starts the agent. Each session enrolls independently.
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "ConnectLive"; \
  ValueData: "\"{app}\ConnectLive.exe\" /background"; \
  Tasks: autostart; Flags: uninsdeletevalue

; 3. Install metadata — self-update and support tooling read these instead of
;    probing the filesystem.
Root: HKLM; Subkey: "Software\ConnectLive"; \
  ValueType: string; ValueName: "InstallPath"; ValueData: "{app}"; \
  Flags: uninsdeletevalue
Root: HKLM; Subkey: "Software\ConnectLive"; \
  ValueType: string; ValueName: "Version"; ValueData: "{#AppVer}"; \
  Flags: uninsdeletevalue

[Icons]
; 4. All-users Startup folder shortcut — visible in shell:common startup.
Name: "{commonstartup}\ConnectLive"; Filename: "{app}\ConnectLive.exe"; \
  Parameters: "/background"; Comment: "ConnectLive background agent"; \
  Tasks: autostart

[Run]
; Pre-step: kill any running Agent so the file copy / firewall rule cannot be
; blocked by a locked exe. RestartApplications=no keeps the installer from
; relaunching it; the post-install line and autostart triggers do that.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLive.exe"; \
  Flags: runhidden

; Outbound firewall rule for the Agent (HTTPS only).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLive.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; 5. Per-machine ONLOGON Scheduled Task — the most robust logon trigger.
; /RL LIMITED = LeastPrivilege (asInvoker), /DELAY 0000:10 = 10s so the
; network stack is up, /IT = only fire for interactive logons (the agent needs
; a desktop for capture and consent). Flag casing MUST stay lowercase
; /background — every trigger writes the same argv so audits are trivial.
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /F /SC ONLOGON /TN ""ConnectLiveAgent"" /TR ""\""{app}\ConnectLive.exe\"" /background"" /RL LIMITED /DELAY 0000:10 /IT"; Flags: runhidden; Tasks: autostart

; Launch the Agent after install so the user sees it start.
; /background: no splash, straight into enrollment + heartbeat.
;
; shellexec        — use ShellExecute (honors the manifest, unlike CreateProcess).
; runasoriginaluser — launch as the interactive desktop user, NOT the elevated
;                     installer token. The Agent must run in the user's session
;                     so its HKCU Run key writes into the correct hive.
;                     Without this flag an admin-manifested EXE fails with
;                     "CreateProcess failed; code 740 — requires elevation".
Filename: "{app}\ConnectLive.exe"; Parameters: "/background"; Flags: nowait postinstall skipifsilent shellexec runasoriginaluser

[UninstallRun]
; Remove the logon Scheduled Task first so nothing relaunches the Agent mid-uninstall.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""ConnectLiveAgent"""; Flags: runhidden; RunOnceId: "DelConnectLiveTask"
; Kill the Agent process cleanly.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLive.exe"; Flags: runhidden; RunOnceId: "KillAgent"
; Remove firewall rule.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Agent Outbound"""; Flags: runhidden; RunOnceId: "FwAgent"

[UninstallDelete]
; The Startup folder shortcut is not auto-removed by the Registry section.
Type: files;      Name: "{commonstartup}\ConnectLive.lnk"
Type: files;      Name: "{commonappdata}\ConnectLive\device.dat"
Type: files;      Name: "{commonappdata}\ConnectLive\install.log"
Type: dirifempty; Name: "{commonappdata}\ConnectLive"
