
## Stage 1 — Full rollback of the TURN integration (no partial keep)

Every touchpoint of the Metered work gets removed. Nothing of it survives.

**Web console**
- `src/lib/webrtc-live.ts`: delete the `import { getIceServers }` line and the whole server-ICE block inside the kickoff IIFE (the `getIceServers()` call, `setConfiguration()`, the `connectTimeoutMs` assignment, and the ice-config console log). Rename `FALLBACK_STUN` back to `STUN_SERVERS` and pass it directly into `new RTCPeerConnection({ iceServers: STUN_SERVERS })` as the only config.
- Watchdog: `connectTimeoutMs` becomes a fixed `10_000` constant again — no server-supplied ceiling, no 20 s TURN branch. Remove the `DISCONNECT_GRACE_MS` relay-flap grace and let `disconnected` behave as it did before the TURN change.
- Remove `candidateType()` relay reporting only if it was added for TURN; the plain `reportCandidatePair()` diagnostic log stays (it costs nothing and is not TURN-specific).

**Agent**
- `agent/src/WebRtcSession.cs`: delete `ResolveIceServers()` entirely. `BuildPeer()` builds `new RTCConfiguration { iceServers = new List<RTCIceServer> { new() { urls = "stun:stun.l.google.com:19302" } } }` inline.
- `agent/src/ApiClient.cs`: delete `GetIceServersAsync` and its DTOs; remove the `/api/public/ice` line from the header doc comment.

**Native admin**
- `admin/src/Media/WebRtcClient.cs`: delete the `App.Api.GetIceServersAsync` block; hardcode the single Google STUN entry. Restore the blind connect watchdog to its original **12 s** constant and drop the second `GetIceServersAsync` call that computed the ceiling.
- `admin/src/Api/ApiClient.cs`: delete `GetIceServersAsync` + ICE DTOs.

**Server**
- Delete `src/lib/ice.server.ts`, `src/lib/ice.functions.ts`, and `src/routes/api/public/ice.ts`.
- `src/shared/api-routes.ts`: remove the `ice:` entry and the sentence about `/api/public/ice` from the header comment.
- `ENDPOINTS.md`: drop the ICE row.
- Remove the `METERED_APP_NAME` / `METERED_SECRET_KEY` secrets from the backend so nothing can accidentally re-enable it.

**Baseline check before touching anything else**
- Typecheck + `bun run scripts/verify-agent-routes.ts` (expected count drops by one — I'll update the expectation).
- Rebuild agent + admin, start a session, and confirm: peer reaches `connected`, curtain engages on click and stays engaged for >30 s continuous, curtain releases on toggle-off. I will not move to Stage 2 until this is confirmed green.

## Stage 2 — Video fixes only (local code, no network layer)

### 2a. Blue picture — copy the JPEG path's channel handling
`agent/src/ScreenCapture.cs` `TeeToWebRtc()` currently runs a hand-written per-pixel loop that rewrites `B,G,R,X → R,G,B,0xFF` and then tells SIPSorcery the buffer is `Bgra`. That double-handling is exactly what turns the desert blue, and the loop is also a CPU hog on the capture thread.

Fix: delete the swap loop. Copy the rows verbatim (only stripping GDI stride padding, which the JPEG path implicitly does too), force the 4th byte to `0xFF`, and hand it to `ExternalVideoSourceRawSample(..., VideoPixelFormatsEnum.Bgra)`. GDI `Format32bppRgb` **is** BGRA in memory — same bytes the JPEG encoder reads correctly — so the declared format now matches reality and no reorder happens in our code.

### 2b. 1 fps — uncap the capture tee
`TeeToWebRtc(scaled, throttled: true)` is called on both idle branches and gates pushes to one per 500 ms. When the dirty-rect/hash detector marks frames unchanged (which it does aggressively — it samples only ~4 k bytes), the stream sits on the idle path and the admin sees ~1–2 fps.

Fix:
- Drop the idle throttle from 500 ms to **200 ms** for genuinely-unchanged frames (keepalive only), and
- Push **every** frame at full rate on the changed path (already `throttled: false`, but the idle-detection hysteresis of `idleCount >= 3` will be tightened so motion resumes full rate on the first changed frame instead of after the backoff unwinds).
- Loop delay stays at 33 ms on the motion path — that is the 30 fps ceiling.
- Keep the existing `webrtc video pipe: pushed=/encoded=/dropped=` 5 s log so the real rate is measurable.

### Verify
- Agent log shows `pushed` climbing at ~30/s while moving a window, `encoded` tracking it.
- Web console HUD FPS reads well above 1 during motion.
- Colors correct on a known reference (blue sky stays blue).
- Curtain still engages/releases — re-checked after the capture change, since it shares the agent's threads.

## Technical notes
- No schema changes, no new dependencies, nothing added to the network layer.
- Rollback and video fix are two separate commits so Stage 1 can be kept even if Stage 2 needs another pass.
- Repackaged zips only after both stages verify.
