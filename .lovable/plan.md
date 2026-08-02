## Verified diagnosis

The live path is:

```text
Agent DXGI/GDI capture
  -> tightly packed raw pixels
  -> SIPSorcery VP8 encoder
  -> direct WebRTC/STUN media
  -> web/native admin renderer

Parallel fallback:
Agent JPEG upload -> session_frames -> Realtime/HTTP -> admin image
```

The database is not rendering WebRTC video; it only persists signaling and the JPEG fallback. The screenshot’s `prflx` state proves ICE established a direct peer path, while `0 fps` proves that connection state was being reported without confirmed decoded media.

Confirmed problems:
- Agent sends GDI/DXGI `B,G,R,X` bytes into the installed encoder package’s conversion path that consumes `R,G,B,A`, causing incorrect chroma/color and striped frames.
- Scaled dimensions can be odd (for example 960x539), which is invalid/risky for VP8 I420 2x2 chroma planes.
- Agent codec restriction failures are swallowed and negotiated format is not explicitly verified as VP8.
- A restarted agent polls signaling from cursor `0`, so a long-lived session can replay old offers and ICE before reaching the current negotiation.
- Standalone agent idle heartbeat waits up to 60 seconds, explaining queued wake/restart commands despite an apparently online device.
- Native admin labels WebRTC “live” when ICE connects, without proving video RTP/decoded frames.
- No database column has been proven safe to remove. `standing_consent` appears unused, but deletion will be deferred rather than risk a regression.

## Implementation

1. **Correct raw video input**
   - Keep DXGI’s documented `B8G8R8A8` capture format.
   - Repack every row using the source stride and convert `B,G,R,X` to the encoder package’s expected `R,G,B,A` byte order.
   - Force scaled width and height to even values before JPEG/WebRTC processing.
   - Reject malformed raw buffers before they reach VP8.

2. **Harden DXGI row handling**
   - Copy exactly `width * 4` visible bytes per row while advancing the source by `RowPitch` and destination by its own stride.
   - Fail cleanly to the existing GDI/JPEG fallback if either pitch cannot contain a full visible row.
   - Preserve full-frame capture; do not introduce a second graphics route or change STUN networking.

3. **Make codec negotiation explicit**
   - Log codec-restriction failures instead of swallowing them.
   - Verify VP8 is present before adding the send track.
   - Accept only a negotiated VP8 format before marking the encoder ready.
   - Keep JPEG fallback active if VP8 is unavailable.

4. **Stop stale signaling replay**
   - On an agent’s initial signal poll, anchor delivery at the newest admin offer and return that offer plus its following ICE candidates.
   - Continue using the existing monotonic cursor and idempotent `attempt_id` flow afterward.
   - Preserve admin-client binding and STUN-only Google configuration.

5. **Restore standalone command responsiveness**
   - Reduce the no-session heartbeat interval from 60 seconds to 10 seconds because there is no updater/SSE helper in the current standalone architecture.
   - Keep the active-session 5-second cadence and existing exponential failure backoff.

6. **Report real media health**
   - Web admin: add a periodic inbound-video liveness check using RTP bytes/frames decoded; if decoded frames stop while ICE remains connected, switch visibly to fallback and request a clean stream rebuild rather than displaying a frozen “live” surface.
   - Native admin: only promote transport to “WebRTC video” after the first video RTP packet; track packet freshness and return to Realtime/JPEG fallback when stale.
   - Keep the curtain/input dead-man path independent so video failure cannot disable curtain release.

7. **Backend optimization without destructive cleanup**
   - Verify/add the unique partial index for `(session_id, attempt_id)` if absent.
   - Add a command lookup/expiry index to improve heartbeat wake/restart delivery.
   - Change `session_frames` replica identity from FULL to DEFAULT because consumers only use the new row and the table has a primary key; this reduces fallback replication overhead.
   - Do not drop any columns in this pass.

8. **Validation**
   - Build both Windows projects through their existing scripts.
   - Run route verification and current smoke tests.
   - Validate a fresh and reused session: offer/answer ordering, first decoded frame, sustained FPS, correct red/blue colors, static-screen keepalive, JPEG fallback, curtain engage/release, queued wake/restart acknowledgement, and reconnect after agent restart.
   - Repackage Agent and Admin only after all checks pass.