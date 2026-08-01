Adopting your split and carve-out. Three deployments, performance first.

## PR #1 — Live view + input latency (ship and verify first)

### 1. Mount the WebRTC video (the actual fix)

`console.tsx` calls `startWebRtcLive()` but never puts `live.video` in the DOM — only `sendInput` is used, so the visible surface is always the base64 JPEG from `session_frames`. Fix:

- Render `live.video` as the primary layer inside the live surface; keep the JPEG `<img>` as a second layer that is only visible while RTC state is not `connected`.
- Suspend the `session_frames` realtime subscription and the 3s poll while RTC video is connected; resume automatically on `failed` / `superseded`.
- Cursor SVG overlay sits above both, scaled to the active layer.
- Health pill gains explicit transport labels: `WebRTC video`, `Frame fallback (n fps)`, `Reconnecting`.

**Pixel accuracy across the swap (your condition).** One shared mapping function takes the *active layer's* natural size — `video.videoWidth/videoHeight` when RTC is visible, `liveFrame.width/height` when the JPEG is visible — plus the layer's rendered client rect, and returns normalized 0–1 coordinates. Both layers use identical `object-contain` letterboxing so the rect maths is the same; only the source dimensions differ. Verified in both directions with a Playwright run: click a known target with RTC up, force the RTC socket to fail, click the same target on the JPEG layer, and assert both produce the same normalized coordinates within a 1px tolerance. If the natural size of the active layer is not yet known (video before first frame), input is held rather than sent against a guessed size.

### 2. Input latency

- Browser-side coalescer: one pointer-move flush per animation frame (~16ms, latest position only); buttons, wheel and keys sent immediately and in order. Replaces the fixed 24ms throttle.
- DB fallback path batches events into one insert per ~50ms window instead of a row per event.
- `agent/src/InputRelay.cs`: 90ms fixed poll → adaptive 25–60ms in control mode, 250ms in view mode.

**Curtain dead-man ping — revised after checking the numbers.** Verified today: the console pings `curtain_on` every **1s** (`console.tsx:526`) and the agent releases the block when no ping has arrived for **5s** (`InputRelay.cs:106`, `InputBlocker.CheckWatchdog`). The `bind_admin` heartbeat runs at **15s** (`webrtc-live.ts:31`) — that is three times *longer* than the watchdog, so moving the ping onto `admin_bound_at` as originally proposed would make the curtain lift while the admin is still present. Dropping that idea. Instead:

- Curtain heartbeat moves onto the **WebRTC data channel** at the same 1s cadence — no DB write at all, 5x margin against the unchanged 5s watchdog.
- When the data channel is down, it falls back to the existing 1s `curtain_on` insert, exactly as today.
- Watchdog timeout stays 5s; refresh interval stays 1s. Margin: 5x on the fast path, 5x on the fallback path. Neither sticking nor early-lift changes behaviour.

### 3. Native admin console parity

- `FrameFallbackPump` 200ms → 120ms fast / 600ms idle; `CursorPollPump` 100ms while in control.
- Surface the WebRTC failure reason in the existing banner so a 5fps fallback session is visibly a fallback.

### 4. Pipeline audit

- `ENDPOINTS.md` gains a **Transport / fallback** column per route: primary, fallback, retry policy, failure mode. Covers frames (RTC video → JPEG, new), inputs, signals, cursor, power, wake.
- Explicit note in `ENDPOINTS.md` that ERC-20 confirmation is **webhook-only** today, with no chain polling, per your carve-out.
- `scripts/verify-agent-routes.ts` gains latency assertions.

**Verification before PR #2 starts:** Playwright run against the live console proving RTC video renders, the swap keeps clicks accurate both directions, and the fallback still works when RTC is blocked.

## PR #2 — Payments (only after #1 is live and verified)

- New `/connectlive/payment` route: own sign-in + `PaymentsPanel`, server-side gated to `admin` / `super_admin`.
- Remove the Payments nav entry and tab render from `/console`; remove the "Payment admin" toggle from `/connectlive/admin`, replaced by a discreet link. `?tab=payments` redirects to the new route.
- Realtime on `orders` + `payment_events` for the order page and the panel; existing 10s / 60s polls stay as fallback when the socket is unhealthy. Needs a small migration adding both tables to the `supabase_realtime` publication.
- CDP health line: config validity, webhook secret present, last webhook received, last reconcile run.

## PR #3 — ERC-20 (isolated, later)

Not touched in #1 or #2. Chain polling for USDT/USDC in `fetchInboundTxs` plus the external API key ships alone, on its own release.
