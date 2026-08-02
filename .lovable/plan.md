## What the two screenshots prove

Both shots are the same desktop, seconds apart:

- **"WebRTC video" pill** → the desert wallpaper renders **blue**, the lake **orange**.
- **"Connecting / Stalled" pill** (JPEG fallback path) → the same wallpaper renders **correctly orange**.

The JPEG pipeline is colour-correct; only the WebRTC path is wrong, and the colours are exactly inverted between the red and blue channels. That is a classic **R/B channel swap in the BGRA → I420 conversion**, not a brightness, gamma or alpha problem. The earlier "darkened" fix (32bppRgb + SourceCopy) was correct and stays; this is a separate, second defect on the video tee only.

Two more things visible in the shots:
- Both states report **1 fps** in the overlay, even while streaming video — the counter only tracks JPEG frames, so a healthy 30 fps video stream still reads "1 fps".
- The pill flips to **"Connecting … Stalled"** while the picture is actually still arriving over the fallback, which reads as a dead session.

## Changes

### 1. Colour: correct the channel order handed to the encoder (agent)

In `agent/src/ScreenCapture.cs` → `TeeToWebRtc`, the locked GDI buffer is passed straight through as `Bgra`. The encoder's conversion is consuming it in the opposite order. Fix by packing an explicit, tightly-packed buffer for the encoder instead of relying on the GDI layout:

- Copy row-by-row using `data.Stride` so the destination is exactly `width * 4` per row — this also removes the **stride-padding skew** that appears on odd widths today, where the frame shears diagonally.
- Write the bytes in the order the encoder actually wants, with the alpha byte forced to `0xFF`.
- Keep the existing 32bppRgb/SourceCopy capture untouched.

`agent/src/WebRtcSession.cs` → `PushFrame` gains an explicit tightly-packed contract (no stride argument) so no future caller can reintroduce the padding bug.

Verification is visual and unambiguous: the desert must render orange over WebRTC, exactly matching the JPEG fallback shot.

### 2. Frame vitality and the fps readout

- The tee is throttled to ~1 push/sec whenever the dirty-rect check says "unchanged". During actual motion it already runs full rate, but the overlay's counter never sees it. Feed the overlay a **transport-aware fps** — count decoded video frames when WebRTC is the active surface, JPEG arrivals otherwise.
- Raise the idle keep-alive from 1 s to ~500 ms so a static desktop recovers faster after a decoder hiccup, without meaningfully raising CPU.

### 3. Stop the false "Connecting / Stalled" banner

`src/routes/_authenticated/console.tsx` currently marks the session stalled on a frame-age timer that ignores the video track. If WebRTC is delivering, the session is live — the stalled/connecting state must only apply when **both** transports are quiet. Same rule mirrored in the native console's status text so the two clients agree.

### 4. Verify every route

Two passes, reported as a table:

- **Static audit** — every file under `src/routes/`, confirming each `createFileRoute("…")` string matches its filename, every page route has its own `head()` metadata, and no orphaned/duplicate paths. Cross-check the 18 API routes against `ENDPOINTS.md` and against actual call sites in the web console, `agent/src/ApiClient.cs`, and `admin/src/Api/ApiClient.cs` — flagging any endpoint a client calls that no longer exists, and any route nothing calls.
- **Live smoke test** — run `scripts/verify-agent-routes.ts`, `scripts/verify-payment-routes.ts`, `scripts/e2e-smoke.ts` and `scripts/e2e-wake.ts` against the running app, plus a sweep of every public page route and each `/api/public/*` endpoint, asserting authenticated ones reject anonymous callers (401) rather than leaking data.

Anything the sweep finds gets fixed in the same pass; anything ambiguous is reported rather than silently changed.

### 5. Repackage

New agent source zip (v1.7) and admin console zip (v1.5) once the colour fix is in, so the Windows build you compile matches this code.

## Technical notes

- Root cause of the tint is byte order at the `ExternalVideoSourceRawSample` boundary, confirmed by the JPEG path — which reads the *same* `scaledBmp` — being correct.
- Stride padding is only harmless while width is a multiple of 4 at 32bpp; the low-bandwidth 960px profile and non-standard resolutions can break that, so the packed copy is a real fix, not a defensive one.
- No database, RLS, or ICE/TURN changes — that work landed last turn and stays as is.
