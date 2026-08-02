## Goal

Every peer currently hardcodes STUN-only (`stun:stun.l.google.com:19302`) in three places:
`src/lib/webrtc-live.ts:28`, `agent/src/WebRtcSession.cs:79`, `admin/src/Media/WebRtcClient.cs:71`.
No relay candidate is ever gathered, so any pair that can't do a direct/reflexive hole-punch
never completes ICE. This change adds Metered TURN, served from the backend (credentials
never in a client binary or bundle), and stops the watchdog from killing negotiations that
are still legitimately in progress.

Explicitly out of scope: the blue tint (YUV plane swap) and the 1 fps cap. A stable,
still-blue, still-1fps stream after this lands is the success condition.

## 1. Server-issued ICE configuration

New `src/lib/ice.server.ts`:

- Calls Metered `https://<METERED_APP_NAME>.metered.live/api/v1/turn/credentials?apiKey=<METERED_SECRET_KEY>`
- [{ https://zoomlite.metered.live/api/v1/turn/credentials?apiKey=5b142aafdb1a7943622e9b9ef1268dff16f2](https://zoomlite.metered.live/api/v1/turn/credentials?apiKey=5b142aafdb1a7943622e9b9ef1268dff16f2) }  
(both secrets already saved; read inside the handler, never at module scope).
- In-memory cache with a TTL below the credential lifetime (~50 min) so we don't hit the  
API on every session start.
- Always prepends Google STUN and returns `{ iceServers, hasTurn }`. If Metered errors or
the secrets are absent, it degrades to STUN-only with `hasTurn: false` — a TURN outage
must never block a session that could connect directly.

Two consumers:

- `src/lib/ice.functions.ts` — `getIceServers` server fn (`requireSupabaseAuth`) for the web console.
- `src/routes/api/public/ice.ts` — for the two C# clients. Authorises the caller as either
an enrolled device (`X-Device-Id` + `X-Device-Token`, same check the other
`/api/public/agent/*` routes use) or a signed-in admin (`Authorization: Bearer <jwt>`
validated against the backend). Unauthenticated callers get 401; no credentials leak
to anonymous requests.

## 2. Wire the three peers

- **Web console** (`src/lib/webrtc-live.ts`): fetch the ICE config before constructing
`RTCPeerConnection`, drop the `STUN_SERVERS` constant, keep the STUN-only literal solely
as the local fallback if the fetch fails.
- **Agent** (`agent/src/WebRtcSession.cs`): `BuildPeer()` becomes async-fed by an
`ApiClient.GetIceServersAsync()` (device-token headers, cached for the process lifetime
with a refresh on 401/expiry), mapped to `RTCIceServer { urls, username, credential }`.
- **Native admin** (`admin/src/Media/WebRtcClient.cs`): same fetch through `App.Api`, using
the existing admin bearer.

## 3. Watchdog: ICE-state-driven, not a blind timer

Current behaviour (`webrtc-live.ts:238`) flips to `failed` 10 s after start if `state` is
still `"connecting"`, regardless of what ICE is doing — relayed gathering routinely takes
longer than that, so it kills connections that were about to succeed.

New rule, applied identically in the web console and mirrored in both C# clients:

- The watchdog **never fires** while `iceConnectionState` is `checking`, `connected`, or
`completed`. Reaching `checking` is progress and restarts the clock.
- `failed` is reported immediately when ICE itself reports `failed` — no waiting out the timer.
- Hard ceiling only for the case where ICE never leaves `new`/`gathering`: **10 s when the
config is STUN-only, 20 s when a TURN server is present** (`hasTurn` drives which).
- `disconnected` no longer means dead: it starts a 5 s grace window and only escalates to
`failed` if ICE hasn't returned to `connected`/`completed`, since a relayed path flaps
through `disconnected` on rebinding.

## 4. Diagnostics for your LAN vs cross-network test

- Log the selected candidate pair type (`host` / `srflx` / `relay`) once ICE connects, and
surface it in the existing admin transport pill (e.g. "WebRTC video · relay"). That turns
your test into a direct read: same-LAN should show `host`/`srflx`, cross-network should
show `relay` once TURN works.
- Log `hasTurn` and the ICE-server host list (never the credential) at session start.

## Technical notes

- Metered credentials are short-lived and per-request; caching is server-side only, so a
captured client binary yields nothing durable.
- The `iceServers` shape is identical across the three clients so codec/ICE parity stays in
lockstep, matching the existing VP8 pinning guardrail comments.
- No database migration, no schema change, no change to the signalling tables or the
frame/cursor fallback path.