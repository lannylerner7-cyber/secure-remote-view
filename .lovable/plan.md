# WebRTC Migration — with automatic fallback to the existing HTTPS stream

Goal: cut live-view latency from ~500 ms to <100 ms when the network allows it, while keeping the current HTTPS frame-stream as a guaranteed fallback so **no session ever dies** because a firewall blocked WebRTC.

Fallback cascade we're implementing:

```text
[1. P2P via STUN] ──fail──► [2. HTTPS frame-stream (already shipping)]
   sub-50ms                    ~500ms, 100% reliable
```

TURN/TURNS is designed for later — the app-level HTTPS fallback already covers the "no P2P" case at 100% success, so we ship without paying for a TURN relay.

---

## 1. Signaling channel

New TanStack public route: `src/routes/api/public/agent/session.$sessionId.signal.ts`

- `POST` — agent or admin publishes an SDP offer/answer/ICE candidate for that session (`{ from: "admin"|"agent", kind: "offer"|"answer"|"ice", payload }`).
- Stored in a new `session_signals` table (id, session_id, from, kind, payload jsonb, created_at).
- Admin uses Supabase Realtime `postgres_changes` on `session_signals` to receive agent messages in real time (same pattern as `session_frames`).
- Agent polls `GET /api/public/agent/session/$id/signal?since=<id>` on a 500 ms interval (already how it polls inputs).

Migration: create `session_signals` + GRANT + RLS (admins read all, agent inserts scoped to `device_id` via `verifyDevice`).

## 2. Agent side (C# Worker)

- Add **SIPSorcery** NuGet (`SIPSorceryMedia.Encoders` for VP8) to `agent/src/ConnectLiveAgent.csproj`. Pure managed, bundles cleanly into single-file publish.
- New `agent/src/WebRtcSession.cs`:
  - Creates `RTCPeerConnection` with `iceServers: [{ urls: "stun:stun.l.google.com:19302" }]`.
  - Adds a video track fed from `ScreenCapture` (reuse current 7 fps GDI loop, but feed raw BGRA into SIPSorcery's VP8 encoder instead of JPEG).
  - Adds a reliable+ordered `RTCDataChannel` named `inputs`; on message → same `Apply(JsonElement)` path used by `InputRelay.PollInputsAsync` today. Polling loop stays as fallback.
  - Sends ICE candidates + offer answer through the new signaling endpoint.
- `Agent.cs` starts the WebRTC session when a session becomes `active`; on ICE `failed`/`disconnected` for >5 s, closes the peer connection — HTTPS stream keeps running the whole time so there's nothing to "fall back to", it's already live.

## 3. Admin side (React)

`src/routes/_authenticated/admin.tsx`:

- On live-view open, create `RTCPeerConnection` with the same STUN server, subscribe to `session_signals` Realtime, send offer.
- Render incoming video track into a `<video autoplay muted playsinline>` **layered on top of** the existing `<img>` frame stream.
- Track connection state:
  - `connected` → hide the `<img>`, show `<video>`, label pill: **live · webrtc** (green).
  - `checking`/`disconnected`/`failed` → hide `<video>`, show `<img>`, label pill: **live · https** (amber).
- Route mouse + key events through the data channel when open, else fall back to the existing `POST /session/$id/inputs`. Zero behavior change for the operator.
- Curtain pinger, trackpad, on-screen keys, shared note — all untouched.

## 4. What stays exactly as it is

- HTTPS frame stream (`ScreenCapture` + `session_frames`) — the fallback.
- Input polling endpoint — the fallback for the data channel.
- Curtain mode, dead-man release, standing consent, pairing flow, Watcher/Worker split, RBAC, Telegram, session indicator.
- Normalized 0–1 coordinates — same wire format on both transports.

## 5. Deliverables

- Migration for `session_signals` (table + GRANT + RLS).
- New route: `src/routes/api/public/agent/session.$sessionId.signal.ts`.
- Admin panel WebRTC layer with automatic HTTPS fallback + status pill.
- Agent: `WebRtcSession.cs`, `Agent.cs` wiring, `ConnectLiveAgent.csproj` gains SIPSorcery.
- Refreshed `agent/INSTALL.md` (note the new NuGet, exe size ~+5 MB, no user-facing changes).
- Rebuilt `ConnectLiveAgent.zip` at `/mnt/documents/ConnectLiveAgent.zip`.

## 6. Out of scope this pass (called out honestly)

- **TURN / TURNS relay.** ~20–30% of strict corporate networks won't complete P2P via STUN alone. Those sessions transparently use the HTTPS stream — same UX as today, just no latency win. When you're ready to pay for a TURN server (Metered/Twilio/self-hosted Coturn), we add its URL + credentials as secrets and drop them into the `iceServers` array on both sides. No code refactor needed.
- **Hardware video encoding (NVENC / AMF / Media Foundation).** SIPSorcery ships software VP8; ~8–15% CPU on an i5 at 720p/15 fps. Acceptable for support sessions. NVENC is a separate optimization card.
- **H.264.** VP8 first because SIPSorcery's software encoder is battle-tested; H.264 needs a native codec DLL and complicates single-file publish.

## Technical notes

- SIPSorcery is MIT, pure managed, ~2 MB. Works inside a single-file self-contained publish; no native bindings to smuggle.
- SDP + ICE payloads are small (<4 KB); polling every 500 ms is fine and matches the existing input-poll cadence.
- Data-channel input path is `reliable: true, ordered: true` — matches TCP semantics, so no dropped clicks. Video track is unreliable/unordered by design (that's the whole point).
- We do **not** need to change `ScreenCapture.cs` output — SIPSorcery accepts BGRA frames; we just tee the same frame into both encoders (JPEG for HTTPS fallback, VP8 for WebRTC) so the fallback is always warm and swap-over is instant.
- If SIPSorcery's single-file publish surfaces a trimming issue (it occasionally does with reflection-heavy code), we disable trimming for the Worker csproj — exe grows ~2 MB, no behavior change.

Preserved (no removals): standing consent · pairing code · curtain mode + SetWindowDisplayAffinity · shared note overlay · resizable trackpad · slide-out on-screen keys · Telegram notifications · RBAC · session recording hooks · draggable 190×30 indicator · Watcher/Worker split · exponential-backoff heartbeat · 3-fail dead-man release.

&nbsp;

> **Minor implementation tip:** When you implement the RTCDataChannel for mouse and keyboard inputs on the React side, wrap your dataChannel.send() calls in a check for dataChannel.readyState === 'open'. If it isn't open, immediately route the input to your existing HTTPS POST endpoint. This guarantees zero dropped clicks during those few seconds where the WebRTC connection is still negotiating