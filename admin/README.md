# ConnectLive Admin (Windows)

## Configure before running source

Edit `src/admin.config.json` before running `dotnet run` from `admin/src`.
The command is `dotnet run`, not `dotnet rub`.

- `baseUrl`: `https://connectliveagent.com`
- `supabaseUrl`: `https://esjlqcfcwewymmeghbvj.supabase.co`
- `supabaseAnonKey`: your project's publishable/anon key. Never use the service-role key.

Both URLs must be HTTPS origins without paths, query strings, or credentials.
An empty key is deliberately not usable; source downloads do not contain keys.
Startup errors identify the exact loaded configuration file. The file beside the
built application takes precedence over `%AppData%\ConnectLiveAdmin\admin.config.json`.
Rebuild after editing the source configuration so it is copied to the output.

The live viewer starts as a centered, resizable window rather than maximized.
Its viewing surface is capped at 960×540 display-independent pixels and shrinks
with the available window space. Fit preserves the remote screen's aspect ratio;
1:1 remains available for native-pixel inspection with scrollbars.

Native technician console — WPF / .NET 8. Companion to the ConnectLive Agent.

See `INSTALL.md` for build and run instructions.

## Scope

- **In**: sign-in, device list, live view (WebRTC H.264 with JPEG fallback),
  mouse/keyboard control, curtain toggle, delete device.
- **Out (web only)**: payments dashboard, orders/checkout, team management,
  notifications inbox, marketplace hub. The app opens these in the default
  browser from the top bar.

## Layout

```
admin/
├── src/
│   ├── ConnectLiveAdmin.csproj
│   ├── App.xaml{,.cs}          bootstrap, single-instance mutex, session gate
│   ├── app.manifest            asInvoker (no elevation)
│   ├── admin.config.json       baseUrl + Supabase publishable key
│   ├── Api/                    ApiClient, AuthStore (DPAPI), Models, AppConfig
│   ├── ViewModels/             MVVM (CommunityToolkit.Mvvm)
│   ├── Views/                  Login / Main / LiveSession XAML + code-behind
│   ├── Media/                  WebRtcClient (SIPSorcery), FrameFallbackPump
│   └── Input/                  MouseInjector, KeyboardInjector, InputCoalescer
└── build.ps1                   dotnet publish → dist/ConnectLiveAdmin.{exe,zip}
```

No new server code — everything reuses the existing agent API surface and
Supabase RLS.

## Signing

`build.ps1` Authenticode-signs and timestamps `ConnectLiveAdmin.exe` before it
is zipped, driven by `CODESIGN_THUMBPRINT` / `CODESIGN_PFX` /
`CODESIGN_SUBJECT`. Unset = unsigned build plus a warning; set = a signing
failure aborts the build. `-SkipSign` opts out. See `../docs/SIGNING.md`.
