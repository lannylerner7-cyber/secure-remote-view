## What's wrong

The signaling path is fine — the admin/web console offers, the agent answers, ICE has TURN. The break is one level deeper: **the agent's video encoder is never told which format was negotiated, and is never started.**

In `agent/src/WebRtcSession.cs` the peer is built with a `VideoEncoderEndPoint`, its `OnVideoSourceEncodedSample` is wired to `SendVideo`, and `ScreenCapture.TeeToWebRtc` pushes tightly-packed RGBA into `PushFrame`. But nowhere in `agent/src` is there:

- `_pc.OnVideoFormatsNegotiated += formats => _videoEnd.SetVideoSourceFormat(formats[0])`
- `_videoEnd.StartVideo()` once the connection reaches `connected`

Without the negotiated format, SIPSorcery's `ExternalVideoSourceRawSample` drops every sample silently (no exception, no log). The peer connects, the console shows a WebRTC pill briefly, no decoded frame ever arrives, `requestVideoFrameCallback` never fires, and the UI settles back onto the 2 fps JPEG pipe. That matches exactly what you're seeing: "video didn't start, just frame fallback".

Secondary gaps found in the same file:
- No keyframe is forced when a new peer connects, so a late subscriber can sit on grey until the encoder happens to emit one.
- `PushFrame` returns silently when the peer isn't `connected`; there's no counter, so we have no signal telling us whether the tee is starving or the encoder is dropping.
- `TeeToWebRtc`'s throttle clock (`_lastTeeUtc`) is static and never reset when a new peer attaches.

## Plan

### 1. Agent — make the VP8 track actually emit (`agent/src/WebRtcSession.cs`)
- In `BuildPeer()`, subscribe to `OnVideoFormatsNegotiated` and call `_videoEnd.SetVideoSourceFormat(...)` with the negotiated VP8 format; log the chosen format.
- On `onconnectionstatechange == connected`, `await _videoEnd.StartVideo()` and force one keyframe so the first pushed frame is decodable.
- Track a `_formatReady` flag; `PushFrame` no-ops until both `connected` and format-ready, and logs once per state transition instead of silently.
- Add a lightweight counter (frames pushed / frames encoded, logged every ~5 s at Info) so a starving pipeline is visible in the agent log instead of invisible.
- Reset the tee throttle when a peer is built so a fresh admin gets an immediate frame rather than waiting up to 500 ms.

### 2. Agent — teardown correctness
- Pause/close the encoder in `TearDownPeer()` before nulling it, and clear `_formatReady`, so a take-over rebuild renegotiates cleanly instead of inheriting a dead encoder.

### 3. Native admin console (`admin/src/Media/WebRtcClient.cs`)
- Mirror the receive-side check: log when the first RTP video packet arrives so "connected but no picture" is distinguishable from "never connected". No behaviour change beyond diagnostics.

### 4. Web console diagnostics (`src/routes/_authenticated/console.tsx`, `src/lib/webrtc-live.ts`)
- Keep the existing pill, but stop calling the transport "WebRTC video" until at least one decoded frame has landed; until then show "WebRTC negotiating". This removes the misleading green pill during exactly this failure and makes future regressions obvious at a glance.
- Log `inbound-rtp` framesDecoded/bytesReceived once at 3 s after connect so the browser console names the culprit (no bytes = transport; bytes but no frames = decode/format).

### 5. Repackage
- Bump `agent/src/ConnectLiveAgent.csproj` to 1.8.0, republish `ConnectLive-RemoteAgent-src-v1.8` and `ConnectLive-AdminConsole-src-v1.6` zips.

## Verification

Code-level: `tsgo` clean, `scripts/verify-agent-routes.ts` and `verify-payment-routes.ts` still green. The decisive check has to happen on a Windows build — after this fix the agent log must show `webrtc format negotiated: VP8` followed by a rising encoded-sample counter, and the console pill must read `WebRTC video · relay|srflx · N fps` with N > 0.

## Note

I have not been able to run the live pipeline from here, so the diagnosis rests on the source: the missing `OnVideoFormatsNegotiated` / `StartVideo` wiring is confirmed absent by search across `agent/src`, and it is sufficient on its own to produce a connected-but-black track. If after the fix the log shows encoded samples flowing but the browser still decodes nothing, the next suspect is the codec pinning between the two sides, and I'll chase that with the new counters rather than guessing.
