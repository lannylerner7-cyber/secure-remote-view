
# IT Support Agent — Own-Branded Build Plan

Three deliverables, all on the clean road (transparent, consented, your branding only).

## 1. Branding (yours, not another vendor's)

I need one input from you before I generate assets: the **product name** and **primary color**. Sensible defaults if you'd rather I just pick:

- Name: **"IT Support Agent"** (neutral, descriptive) or **"[YourCompany] Remote Assist"**
- Color: deep slate/indigo (`#1F2A44`) with a single accent

I'll generate:
- A wordmark + monogram SVG (no third-party logos, ever)
- A 256×256 installer icon (.ico-ready PNG set: 16/32/48/64/128/256)
- A favicon for the admin panel

## 2. Windows Agent — script only (you compile locally)

A single-file PowerShell + C# hybrid you can compile to a signed `.exe` on your box with `dotnet publish` or `ps2exe`. No binary produced here.

**Startup UX** (the piece you asked for, done cleanly):
- WPF splash window, 480×280, centered
- Your wordmark at top, indeterminate progress bar, status text ("Registering with helpdesk…", "Waiting for consent…")
- Closes as soon as the tray indicator is live
- No fake progress; each step reflects a real API call

**Agent behavior** (matches the API contract already built):
- `POST /api/devices/enroll` on first run → stores device token in DPAPI-encrypted local file
- `POST /api/devices/heartbeat` every 30s with the device token
- WebSocket to `/api/ws` for session invites
- On invite: shows **consent dialog** (Allow / Deny), only starts capture after Allow
- Persistent tray icon + on-screen banner while a session is active — cannot be hidden
- Separate second consent prompt before control is granted
- User can end the session from the tray at any time

**Deliverables in the repo:**
- `agent/src/Agent.cs` — service + tray + WPF splash
- `agent/src/ApiClient.cs` — generated from your OpenAPI so routes stay in sync
- `agent/build.ps1` — one command to produce `IT-Support-Agent.exe` and zip it
- `agent/README.md` — how to Authenticode-sign and deploy via MDM/GPO
- `agent/assets/` — your logo, splash CSS-equivalent XAML styling

## 3. Fix the admin viewer WebSocket (the real blocker)

The e2e caught this and it's what's actually stopping end-to-end demos:
- Inspect the proxy config, confirm the upgrade path for `/api/ws`
- Fix client `wsUrl()` if needed and add a reconnect + status indicator
- Re-run the two-context Playwright flow (simulator + technician) to green

## Order of work

```text
1. You confirm name + color (or accept defaults)
2. I generate branding assets                          [~5 min]
3. I write the agent script + build.ps1 + README       [~20 min]
4. I fix the /api/ws upgrade + verify with Playwright  [~15 min]
5. You run build.ps1 locally, sign, deploy to a test box
```

## Out of scope (unchanged from original plan)

- Compiling or signing the binary in this workspace
- Any third-party branding, logo, or asset URL
- Hidden indicators, Defender-exclusion-for-concealment, silent capture

## Question before I start

**Product name and primary color — your call, or should I go with "IT Support Agent" + slate/indigo?**
