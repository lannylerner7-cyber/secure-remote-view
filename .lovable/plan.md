
## Goal

Ship a native Windows `ConnectLiveAdmin.exe` that mirrors the **device console** (login → device list → live view + control) with GPU-accelerated video. Payments, orders, marketplace, and the crypto checkout stay on the existing web panel — the desktop app just links out to them in the browser when a super-admin needs them.

## Scope (v1)

**In:**
- Native login against `POST /api/public/auth/login` (same 3-attempt / 1h lockout as web)
- Device list with live presence (`devices` + `heartbeats` via Supabase Realtime over WebSocket)
- Session invite → live view window with:
  - WebRTC H.264 video track over existing `/api/public/agent/session/$id/signal` handshake
  - Hardware decode via `MediaFoundationVideoRenderer` → `D3DImage` in WPF
  - Local cursor overlay driven by existing `session_cursors` broadcast (no cursor drawn in captured frames)
  - Absolute-coordinate mouse injection (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`)
  - 60Hz input coalescing loop, drag-select, wheel, all modifier keys
- Curtain / pause control (reuses agent's existing `input.block` / `curtain.on` commands)
- End session, delete device (calls existing endpoints)

**Out (stays on web, opened via `Process.Start` in default browser):**
- `/console?tab=payments`, `/order/*`, `/console?tab=team`, notifications inbox, marketplace `/`
- The web `/connectlive/admin` login stays live as a fallback surface

**Not in v1** (deferred per your answers): Wake-on-LAN, subnet crawler, dedicated Node signaling gateway.

## Architecture

```text
admin/                                    (new sibling of agent/)
├── src/
│   ├── ConnectLiveAdmin.csproj          net8.0-windows, WPF, SIPSorcery, SIPSorceryMedia.Encoders
│   ├── App.xaml / App.xaml.cs           WPF bootstrap, single-instance mutex
│   ├── app.manifest                     asInvoker (no elevation needed for admin panel)
│   │
│   ├── Api/
│   │   ├── ApiClient.cs                 HttpClient wrapper, base URL from admin.config.json
│   │   ├── AuthStore.cs                 Persists Supabase session in DPAPI-encrypted %AppData%
│   │   └── Models.cs                    C# records: Device, Session, LoginResponse, Notification
│   │
│   ├── Realtime/
│   │   ├── SupabaseRealtime.cs          ClientWebSocket to wss://<ref>.supabase.co/realtime/v1
│   │   └── ReconnectPolicy.cs           Fibonacci backoff (1,2,3,5,8,13,21s cap)
│   │
│   ├── ViewModels/                      MVVM (CommunityToolkit.Mvvm ObservableObject)
│   │   ├── LoginViewModel.cs
│   │   ├── DevicesViewModel.cs          ObservableCollection<DeviceVM>
│   │   ├── LiveSessionViewModel.cs
│   │   └── RelayCommand.cs
│   │
│   ├── Views/
│   │   ├── LoginWindow.xaml             Slate/indigo (#1F2A44 / #4F7CFF) matches web
│   │   ├── MainWindow.xaml              Device list + toolbar + "Open payments in browser"
│   │   └── LiveSessionWindow.xaml       D3DImage host, cursor overlay Canvas, trackpad, OSK
│   │
│   ├── Media/
│   │   ├── WebRtcClient.cs              SIPSorcery RTCPeerConnection, offer/answer via /signal
│   │   ├── H264Decoder.cs               Media Foundation → IDirect3DSurface9 → D3DImage
│   │   └── CursorOverlay.cs             XAML Canvas rendering session_cursors telemetry
│   │
│   ├── Input/
│   │   ├── MouseInjector.cs             Sends absolute coords + click/wheel to /session/$id/inputs
│   │   ├── KeyboardInjector.cs          Full VK map incl. Ctrl+A/C/V/X/Z, arrows, Home/End
│   │   └── InputCoalescer.cs            16ms tick, volatile LatestState → single packet
│   │
│   └── admin.config.json                { "baseUrl": "https://secure-remote-view.lovable.app" }
│
├── build.ps1                            dotnet publish -r win-x64 --self-contained -p:PublishSingleFile
├── INSTALL.md                           Build + run instructions
└── README.md
```

### Signaling flow (reuses existing endpoints — no new server code)

1. Admin logs in → `POST /api/public/auth/login` → Supabase session stored via DPAPI
2. Realtime WS subscribes to `devices` + `sessions` tables (Supabase Realtime channel with the session's access token)
3. Admin double-clicks a device → `INSERT sessions` (mode='control') via authenticated Supabase REST call
4. Agent picks it up on next heartbeat (already implemented)
5. WebRTC offer/answer flows through `/api/public/agent/session/$sessionId/signal` (already implemented)
6. Video: SIPSorcery negotiates H.264 → MF decoder → D3DImage → WPF renders at 60fps
7. Cursor: subscribes to `session_cursors` realtime channel; overlay redraws locally at ~144Hz
8. Input: 60Hz coalescer → `POST /api/public/agent/session/$sessionId/inputs` (existing endpoint)

### What we're explicitly NOT changing on the server

- No new tables, no new endpoints, no schema changes
- Web `/connectlive/admin` and `/console` stay untouched
- Web `/order/*` and payments panel stay untouched (that's the "order page stays on the webpage" ask)
- Agent code stays untouched (its H.264 track and cursor pump already exist)

## Build & distribution

- Add `admin/build.ps1` producing `admin/dist/ConnectLiveAdmin.exe` (self-contained, single-file, ~80MB)
- Add `admin/dist/ConnectLiveAdmin.zip` alongside the existing agent zip
- Update the web landing page (`/`) with a second download card: **"Admin console (Windows)"** next to the existing agent download
- README + INSTALL docs mirror the agent's format

## Open question I still need answered before implementing

You wrote **"admin signal bot token etc"** — what did you mean? Likely candidates:
- (a) A Telegram/Discord bot that pings the admin.exe when a device comes online?
- (b) A "signaling token" the admin.exe should present when opening WebRTC?
- (c) Something else?

I'll build the plan above as-is (no bot integration) unless you clarify — bot notifications can slot in as a v1.1 addition without disturbing this architecture.

## Risks / notes

- SIPSorcery H.264 decode on the admin side needs the same `SIPSorceryMedia.Encoders` package the agent uses; single-file publish works (already proven by the agent build).
- `D3DImage` interop requires WPF running on the STA thread — MVVM structure handles this.
- Elevation is **not** required for the admin panel (unlike the agent). Manifest stays `asInvoker`.
- The Supabase Realtime WS needs the user's access token refreshed hourly; `AuthStore` will use `POST /auth/v1/token?grant_type=refresh_token` on 401.
