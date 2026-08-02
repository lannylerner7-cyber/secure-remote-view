## Where things stand (verified by reading the code just now)

| Item | State |
|---|---|
| 1. R/B swap + tight packing in `agent/src/ScreenCapture.cs` → `TeeToWebRtc` | Done — row-by-row pointer copy, `drow = r,g,b,0xFF`, no stride padding |
| 1b. `WebRtcSession.PushFrame` tightly-packed contract (no stride arg) | Done |
| 1c. `AllowUnsafeBlocks` for the pointer loop | Present in `agent/src/ConnectLiveAgent.csproj` |
| 2. Idle keep-alive raised to ~500 ms | Done (`throttled` gate is 500 ms) |
| 2b. Transport-aware fps in web console | Done — `requestVideoFrameCallback` counter, pill reads `WebRTC video · relay · N fps` |
| 3. False "Connecting / Stalled" banner | Done — 8 s handover grace; native console watchdog reports `live` while transport is WebRTC video |
| 4. Route audit (static + live) | **Not done** |
| 5. Repackage v1.7 / v1.5 | **Not done** (latest on disk: agent v1.6, admin v1.4) |

So the remaining work is verification and packaging, plus fixing whatever the sweep turns up.

## Plan

### A. Re-verify the client-side fixes as described

- Agent: confirm the JPEG path still uses the untouched `scaledBmp` (colour-correct reference), that `32bppRgb` + `SourceCopy` from the darkening fix is intact in both `ScreenCapture.cs` and `DxgiCapture.cs`, and that no other caller passes a strided buffer to `PushFrame`.
- Native admin (`admin/`): confirm the decoded WebRTC surface needs no matching swap (the swap is on the encoder input, so the decoder output is already correct) and that `LiveSessionViewModel` status text, transport taxonomy, and the fps/last-frame readout agree with the web console wording.
- Web console: confirm the fallback JPEG subscription still resumes correctly after the grace window, so a genuinely dead session still reaches "Stalled".

### B. Static route audit (reported as a table)

- Every file under `src/routes/`: `createFileRoute("…")` string vs filename, duplicate/orphaned paths, and `head()` metadata presence on each page route.
- Every `/api/**` route cross-checked three ways: against `ENDPOINTS.md`, against web-console call sites, and against `agent/src/ApiClient.cs` + `admin/src/Api/ApiClient.cs`. Flag (a) endpoints a client calls that no longer exist, (b) routes nothing calls.

### C. Live smoke tests

- Run `scripts/verify-agent-routes.ts`, `scripts/verify-payment-routes.ts`, `scripts/e2e-smoke.ts`, `scripts/e2e-wake.ts` against the running app.
- Sweep every public page route for 200, and every `/api/public/*` endpoint anonymously, asserting protected ones return 401 rather than data.

Anything broken and unambiguous gets fixed in the same pass; anything ambiguous is reported, not silently changed.

### D. Repackage

- `ConnectLive-RemoteAgent-src-v1.7-<date>.zip` and `ConnectLive-AdminConsole-src-v1.5-<date>.zip` into `/mnt/documents`, after `ENDPOINTS.md` is updated with anything the audit changes.

## Technical notes

- No database, RLS, or ICE/TURN changes — last turn's work stays as is.
- The colour fix cannot be validated from here (it needs a Windows build against a real desktop); the verification I can give is code-level plus the smoke tests. The visual check stays yours: the desert must render orange under the "WebRTC video" pill.
