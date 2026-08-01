; ConnectLive Agent — installer (standalone, agent-only)
;
; What this installer does:
;   1. Copies ConnectLive.exe to Program Files\ConnectLive\
;   2. Creates ProgramData\ConnectLive\ with correct permissions
;   3. Adds an outbound HTTPS firewall rule for the Agent
;   4. Registers a per-machine "ConnectLiveAgent" ONLOGON Scheduled Task as the
;      third logon trigger (complements the HKCU Run key + Startup shortcut
;      that the Agent self-heals on launch).
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
; Install folder — only the Agent binary lives here.
Name: "{app}"; Permissions: admins-full system-full users-readexec
; ProgramData — device.dat (legacy), install.log. The Agent migrates device.dat
; to %LOCALAPPDATA%\ConnectLive on first launch; this dir stays for install.log
; and any leftover legacy artifacts.
Name: "{commonappdata}\ConnectLive"; Permissions: authusers-modify admins-full system-full

[Files]
Source: "..\..\dist\ConnectLive.exe"; DestDir: "{app}"; Flags: ignoreversion

[Run]
; Outbound firewall rule for the Agent (HTTPS only).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ConnectLive Agent Outbound"" dir=out action=allow program=""{app}\ConnectLive.exe"" protocol=TCP remoteport=443"; Flags: runhidden

; Per-machine ONLOGON Scheduled Task — the third (most robust) logon trigger.
; The Agent's StartupSelfHeal writes the HKCU Run key + Startup shortcut on
; every launch; this task covers the case where both of those are missing.
; /RL LIMITED = LeastPrivilege (asInvoker), /DELAY 0000:10 = 10s so the
; network stack is up. Flag casing MUST stay lowercase /background — every
; trigger writes the same argv so audits are trivial.
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /F /SC ONLOGON /TN ""ConnectLiveAgent"" /TR ""\""{app}\ConnectLive.exe\"" /background"" /RL LIMITED /DELAY 0000:10"; Flags: runhidden

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
Type: files;      Name: "{commonappdata}\ConnectLive\device.dat"
Type: files;      Name: "{commonappdata}\ConnectLive\install.log"
Type: dirifempty; Name: "{commonappdata}\ConnectLive"
