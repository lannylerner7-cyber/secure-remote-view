; ConnectLive Agent — Phase 1 installer (Agent only, no Windows Service)
;
; What this installer does:
;   1. Copies ConnectLive.exe to Program Files\ConnectLive\
;   2. Creates ProgramData\ConnectLive\ with correct permissions
;   3. Adds outbound firewall rule for the Agent
;   4. Does NOT register any Windows Service
;   5. Does NOT reference ConnectLiveUpdater.exe or ConnectLiveUpdater
;
; Startup persistence is handled by the Agent itself via HKCU Run key
; written after successful first enrollment — not by the installer.
;
; Build:    iscc packaging\inno\ConnectLiveSetup.iss
; Install:  ConnectLiveSetup.exe
; Silent:   ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES

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
OutputDir=..\..\dist
Compression=lzma2/ultra
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
SetupIconFile=..\..\assets\icon.ico
UninstallDisplayIcon={app}\ConnectLive.exe
CloseApplications=yes
RestartApplications=no

[Dirs]
; Install folder — only ConnectLive.exe here, nothing else.
Name: "{app}"; Permissions: admins-full system-full users-readexec
; ProgramData — device.dat, stop.flag, install.log.
; authusers-modify: Agent (running as logged-in user) reads device.dat,
; writes stop.flag.
Name: "{commonappdata}\ConnectLive"; Permissions: authusers-modify admins-full system-full

[Files]
; Agent only. No ConnectLiveUpdater.exe. No service subfolder.
Source: "..\..\dist\ConnectLive.exe"; DestDir: "{app}"; Flags: ignoreversion

[Run]
; Outbound firewall rule for the Agent (HTTPS only).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLive.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; Launch the Agent after install so the user sees it start.
; /background: goes straight to tray, no splash, begins enrollment + heartbeat.
;
; shellexec        — use ShellExecute (honors any manifest, unlike CreateProcess).
; runasoriginaluser — launch as the interactive desktop user, NOT the elevated
;                     installer token. Tray apps must run in the user's session
;                     so their HKCU Run key writes into the correct hive.
;                     Without this flag, an admin-manifested EXE fails with
;                     "CreateProcess failed; code 740 — requires elevation".
Filename: "{app}\ConnectLive.exe"; Parameters: "/background"; Flags: nowait postinstall skipifsilent shellexec runasoriginaluser

[UninstallRun]
; Kill the Agent process cleanly.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ConnectLive.exe"; Flags: runhidden; RunOnceId: "KillAgent"
; Remove firewall rule.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ConnectLive Agent Outbound"""; Flags: runhidden

[UninstallDelete]
Type: files;      Name: "{commonappdata}\ConnectLive\device.dat"
Type: files;      Name: "{commonappdata}\ConnectLive\stop.flag"
Type: files;      Name: "{commonappdata}\ConnectLive\install.log"
Type: dirifempty; Name: "{commonappdata}\ConnectLive"
