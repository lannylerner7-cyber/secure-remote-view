# ConnectLive Admin — Install & Build

Native Windows console for technicians. Payments and orders stay on the web
panel (`https://secure-remote-view.lovable.app/console?tab=payments`, `/order`),
which the app opens in the default browser from the top bar.

## Prerequisites

- Windows 10 / 11 x64
- .NET 8 SDK (for building only — the produced `.exe` is self-contained)

## Build

```powershell
cd admin
./build.ps1
```

Outputs:

- `dist/ConnectLiveAdmin.exe` — single-file, self-contained
- `dist/ConnectLiveAdmin.zip` — exe + `admin.config.json` + this readme

## Run

Double-click `ConnectLiveAdmin.exe`. Sign in with your technician ID
(3 failed attempts → 1-hour lockout, same as the web panel). Session is
stored under `%AppData%\ConnectLiveAdmin\session.dat`, DPAPI-encrypted for
the current user.

## Configuration

`admin.config.json` (next to the exe) overrides the built-in defaults:

```json
{
  "baseUrl": "https://secure-remote-view.lovable.app",
  "supabaseUrl": "https://<your-project>.supabase.co",
  "supabaseAnonKey": "sb_publishable_..."
}
```

## What lives where

- **Native (admin.exe)**: login, device list, live view, mouse + keyboard
  control, curtain toggle, delete device.
- **Web (opens in browser)**: payments dashboard, orders/checkout, team
  management, notifications inbox, marketplace hub.

## Transport

- Login: `POST /api/public/auth/login` (unchanged from web).
- Devices + sessions + inputs + signals: authenticated Supabase REST as the
  signed-in technician (RLS applies).
- Live pixels: WebRTC (H.264 via SIPSorcery) with automatic fallback to the
  same JPEG frame stream the web console uses.
- Cursor telemetry: overlay rendered locally from `session_cursors`.
