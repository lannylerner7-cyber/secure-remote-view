# ConnectLive Admin (Windows)

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
