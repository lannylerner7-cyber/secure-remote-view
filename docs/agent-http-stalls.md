# JPEG upload stalls and heartbeat disconnects

## Findings and limits

The supplied Windows log is from Agent **1.10.5**, dated **2026-11-06**.
Its times are the device's local clock; no timezone was supplied. This
investigation traced the current repository source, not a verified copy of the
external server's deployed revision.

| Log evidence | What it establishes |
| --- | --- |
| 14:38:15.771: first JPEG uploaded, 1366×768, 17,139 bytes | Capture, JPEG encoding and at least one HTTPS upload succeeded. |
| 14:38:18.779: upload failed; later batches of ten failures roughly 30 seconds apart | Consistent with the source's **3-second per-JPEG deadline**. The old catch discarded cancellation details, so this is not proof of a network, storage, or authorization cause. |
| 14:46:47.772 and 14:47:09.109: explicit 20-second `HttpClient.Timeout` failures | Heartbeat HTTP requests did not finish inside the client deadline. They do not identify which server stage, proxy or connection stalled. |
| 14:47:58.222–14:49:06.530: four consecutive heartbeat failures; dead-man at 14:48:42.002 | The coordinator stops the session on **the first failed heartbeat**, then repeats the safety teardown and dead-man warning on the third. Disconnection is deliberate fail-closed behavior, not evidence that JPEG errors directly terminate sessions. |
| 14:49:28.230: another first-JPEG success | The HTTP path was intermittently usable; an earlier successful upload does not prove sustained delivery. |

The `vpxmd` load failure is a separate native video issue. No codec selection or
dependency changes are part of this investigation. The signal-poll 403 just
after the earlier session ended is not proof that authorization caused the
later upload stalls.

**The initiating infrastructure cause remains unproven.** No correlated server
logs or latency measurements accompanied the original log. The deployment
metadata available to this workspace reports no Replit production deployment;
it provides no telemetry for the externally hosted Coolify application. No
production endpoint was exercised with a device identity, no production data
was changed, and no customer device was used.

## Traced paths

### JPEG

`ScreenCapture.RunAsync` → `LatestWorkPump` → `ApiClient.PostFrameAsync` →
`SendAuthedAsync` → `POST /api/public/agent/session/:id/frame`:

1. Check the current local session and view permission.
2. Keep **one in-flight upload and one replaceable newest pending frame**.
3. Apply the existing **3-second deadline**, now owned by `PostFrameAsync`
   so it can distinguish expiry from cancellation of the session/permission.
4. Send JSON containing the base64 JPEG. No request bodies enter diagnostics.
5. Server: verify device → parse/validate body → look up session and owner →
   reject video-only/inactive sessions → verify view authorization →
   upsert the latest row in **Supabase PostgreSQL `session_frames`**.

This upload path does **not** use a Supabase Storage bucket or App Storage.
Database/PostgREST latency, write failures, trigger rejections, proxy behavior
and connectivity are distinct possibilities. An accepted write alone does not
prove Realtime delivery or that the browser displayed fresh pixels.

### Heartbeat

`Agent.HeartbeatLoop` → `ApiClient.HeartbeatAsync` → `SendAuthedAsync` →
`POST /api/public/agent/heartbeat`:

- Device verification and recorded authorization.
- Request body/telemetry processing.
- Process-runtime RPC and presence/metadata update.
- License lookup, seat evaluation and optional license-state update.
- Session lookup, per-session authorization, and stale-session cleanup.
- Legacy command lookup/dispatch and optional reconnection notification.
- Response serialization and return of current authority.

These awaited stages are sequential. Slow dependencies or a large backlog of
session checks can add up, but the source alone cannot show which happened on
November 6. The server's current Supabase calls do not inherit client
cancellation; a timed-out HTTP call may still finish server work. **Do not
blindly replay it.** Even a heartbeat “probe” can change shared data.

Frame, heartbeat and other short Agent requests share a pooled `HttpClient`.
SSE has its own client. There is no source evidence here for a two-connection
limit or an unbounded JPEG upload queue, so neither is asserted as the cause.
The HTTP request messages are now disposed on all completed/exception paths,
including successful uploads, rather than leaving their image content for GC.

## Diagnostics added

### Agent

`AgentHttpDiagnostics.cs` observes the **actual HTTP attempt**, before 401/403
authority handling. Lines identify:

- `op=frame|heartbeat`, a random per-attempt `request=clh-…`, and attempt number.
- Numeric HTTP status, or `status=none` when no complete response was received.
- HTTP elapsed milliseconds and the unchanged **3000/20000 ms** budget.
- `outcome=deadline` for JPEG expiry; `http_timeout` for the HttpClient timeout;
  `cancelled` for ordinary lifetime teardown; `cancelled_unknown` when cause
  is not established; fixed DNS/connection/TLS/protocol/response error classes.
- Validated server elapsed time, last stage and outcome when available.
- Consecutive failures, recovery counts and suppressed diagnostic counts.

No URLs, queries, response bodies, exception messages, device/session IDs,
tokens, pairing codes, credentials, SDP or image bytes are logged by this
observer. Only known server stage/outcome labels and bounded numeric timing
headers are accepted. Old servers may supply no diagnostic headers.

Each operation has a separate budget: at most six problem/recovery lines per
60-second window, plus one routine sample per 60 seconds. Success/failure
flapping does not reset that budget. Ordinary cancellation is not a warning.
The coordinator's existing fail-closed/dead-man messages remain.

### Server

`agent-http-diagnostics.server.ts` adds:

- Matching random request IDs (strict `clh-` plus 32 lowercase hex characters;
  invalid/missing IDs are replaced).
- Numeric total latency, fixed stage timings, status, and fixed outcome codes.
- One in-flight slow checkpoint at **2 seconds for JPEG**, **10 seconds for
  heartbeat**, and an abort observation when the runtime supplies it.
- Response headers `X-ConnectLive-Request-Id`, `X-ConnectLive-Server-Ms`,
  `X-ConnectLive-Stage`, and `X-ConnectLive-Outcome`.

Slow checkpoints are **observations, not new deadlines**. Logs have a fixed
two-operation state, bounded counters, at most six problem entries per
operation/process/60-second window plus one healthy sample; timers/listeners
are removed at completion. They do not retain per-device maps. Missing sampled
logs are **not proof that a request never reached the server**. A blocked
server event loop also delays the slow checkpoint.

Device/session lookup failures and authorization-RPC unavailability now report
**503**, separately from bad credentials (401), wrong owner (404), or an
inactive/video-only/unauthorized session (409). None permits a write. A failed
authorization RPC no longer mislabels a live database session as stale and
ends it during heartbeat cleanup. The Agent still stops local channels when
that heartbeat fails. Raw frame-write error messages and unexpected upstream
exceptions are replaced with fixed error codes.

No schema migration, storage replacement, deadline extension, capture-queue
expansion, new retry or permission bypass was introduced.

## Reading the next authorized capture

Collect only the new `HTTP op=…` Agent lines and `scope=agent_http` server lines
for the same random request IDs, plus a timestamp/timezone and the deployed
source version. Do not collect request dumps, screen payloads, config files,
pairing credentials or arbitrary response bodies. Keep normal access logs
configured not to record authentication headers or request bodies.

| Observation | Next bounded check |
| --- | --- |
| `deadline`, status none; matching server `slow` at `frame_write` | Inspect read-only Supabase/PostgREST write latency and database waits for that window. This does not identify a specific lock or provider failure by itself. |
| `http_timeout`, status none; server slow in a heartbeat stage | Investigate that stage's dependency/latency, not the native encoder. |
| 401/403 | Check device/view authority through approved administrative procedures; do not erase credentials or weaken grants to mask it. |
| 409 with `video_only_session` / `not_active` | Check the selected session policy and current state; do not bypass video-only restrictions. |
| 503 plus a lookup/authorization outcome | Dependency unavailable; not proof of a revoked token or grant. |
| 500 at `frame_write` | Database write failed; use separately authorized, redacted server/database evidence. |
| 413/429/502/504 with no server headers | Possible gateway/proxy rejection; correlate hosting access/error logs. Status alone is not attribution. |
| Low server time but high client HTTP time | Investigate network/proxy/client queue/response delivery; server timing does not cover these. |
| Client expiry followed by server success | The server finished after the client deadline; this is not proof of delivery to the viewer. |
| No matching server record | Sampling, older deployed code, process restarts, or a pre-handler failure remain possible. Do not call this proof of a client connectivity failure. |

Any real-device confirmation requires an explicitly designated, consented
Windows test machine and separate approval for changes on the external host.
Development and production share external Supabase; using the preview is not
isolation. Windows Agent builds/runs remain manual using `agent/run.ps1`.
No Agent/Admin executable, installer, MSI or release package was built here.

## Verification

Safe, isolated checks:

```sh
pnpm --filter tanstack_start_ts run typecheck
node --test tests/agent-http-diagnostics.cjs tests/jpeg-diagnostic.cjs
node scripts/recorded-authorization-check.cjs
dotnet run --project tests/agent-http-diagnostics/AgentHttpDiagnostics.Tests.csproj
```

The .NET check is a **portable net8.0 unit harness** linking only the diagnostic
observer and a fake HTTP handler. It is not a Windows Agent build or a network
test. Tests cover success and failures, redaction, response metadata, bounded
sampling/recovery, cancellation precedence, DNS/TLS/HTTP timeout classification,
denied writes, unavailable dependencies, and preserved fail-closed source
contracts. These do not certify Windows runtime behavior, production latency,
database triggers/RLS, or a resolved end-to-end screen stall.

Completed in this workspace: the imported application's TypeScript check,
38 JavaScript tests, 18 authorization-handler checks and 53 portable .NET
assertions passed. Unauthenticated preview requests to both changed routes
returned 401 with safe correlation/timing headers before any database access.
The technician sign-in page rendered without browser errors. The development
workflow also reported aborted SSR requests and existing API-deprecation
warnings; these are not correlated evidence for the external production
incident and are not claimed to be resolved by this change.

## Pairing continuity during lookup outages

The same distinction now applies to **every `verifyDevice` caller**, not just
frame and heartbeat. The helper returns an explicit verified, unauthorized or
unavailable result; a caller can no longer opt out of outage classification by
omitting an observer.

| Device verification result | HTTP result and behavior |
| --- | --- |
| Missing/partial credentials, no device row, missing hash or wrong token | 401; no authenticated work occurs. |
| Returned database error, thrown network failure or client-configuration failure | 503 `device_lookup_unavailable`; no body processing, session access, write, stream subscription or TURN mint occurs. |
| Successful lookup and matching token | Continue through the existing ownership, grant, session state, capability and local permission checks. |
| Lookup later recovers | A **new** request can use the same saved identity; no re-enrollment is needed. |

Coverage includes hello, authorization GET/POST, revocation, beacon, Watch, SSE,
release, ICE, power acknowledgements, consent, reconnect, cursor, input polling,
signaling GET/POST, file chunks, frame and heartbeat. ICE/release still support
technician-only callers, but a supplied device credential cannot fall back to
a bearer principal after rejection or an unavailable lookup. Failure responses
contain fixed codes, never provider exceptions or credential values.

Session-permission RPC errors and thrown network failures remain fail-closed.
Frame/heartbeat retain their explicit 503 outcomes and do not end database
sessions merely because authorization could not be checked. Other session
routes retain their existing 403/409 denial contracts; input polling retains
only safety cleanup when its capability checks fail. A device-authentication
success alone is never session authority.

The Windows authenticated send path is isolated in
`agent/src/ApiClient.Authentication.cs`:

- It makes exactly one HTTP attempt, with one snapshot of the paired identity.
  It never deletes `device.dat`, clears credentials, invokes a pairing provider,
  or rebuilds/replays the request after a response.
- 401 and 403 still revoke live permissions and notify the coordinator to close
  channels. A 401 also applies a 60-second cooldown and one fixed diagnostic per
  cooldown. The original 401 is returned as a failure, not converted to success.
- 503 and network failures do not invalidate stored pairing or its local grant.
  A failed heartbeat **still immediately stops the live session**. A later
  successful HTTP request does not revive an already revoked permission object.
- Changing identity is still an explicit foreground pairing operation after
  both credentials and the matching local disclosure have been saved. A late
  response from an older identity cannot reject that newer explicit pairing;
  its failed request is not replayed with the new credentials.
- Signal-poll diagnostics now use numeric status/fixed failure classifications,
  not arbitrary response bodies or exception messages.

This does not add retries to uncertain writes. A failed/timed-out operation may
have reached the server; retaining pairing is not permission to repeat a
consent, revocation, file chunk or other sensitive operation automatically.
It also does not turn a 503 into permission to keep a session alive.

Additional isolated checks:

```sh
node --test tests/agent-pairing-outages.cjs tests/agent-http-diagnostics.cjs \
  tests/jpeg-diagnostic.cjs tests/reconnect-consent.cjs scripts/ice-gateway.test.cjs
node scripts/recorded-authorization-check.cjs
node scripts/server-authorization-check.cjs
dotnet run --project tests/agent-pairing/AgentPairing.Tests.csproj
dotnet run --project tests/agent-http-diagnostics/AgentHttpDiagnostics.Tests.csproj
dotnet run --project tests/agent-grants/AgentGrants.csproj
```

The new portable .NET harness links the **actual authenticated send method**,
diagnostic observer and permission implementation with an in-memory client shell,
fake time and a fake HTTP handler. It does not compile the WPF/Windows project,
use DPAPI or touch credential files. Tests cover success, dependency outages,
true rejection, recovery with the same identity, concurrent 401s, cancellation,
late responses after explicit pairing, request disposal and diagnostic redaction.
The JavaScript matrix executes actual route/auth modules with allow-listed
in-memory dependencies, including database errors that also return data.
The older binding harness also loads its existing pure signaling-ID validator
rather than omitting that dependency.

The imported TypeScript check passed. Nine unauthenticated preview requests
returned 401 before device database access, and the technician sign-in page
rendered without browser errors after the workflow restart. The development
workflow still emitted the previously noted aborted-SSR/deprecation messages;
these are not proof of the external outage's cause or claimed fixed here.
No schema changes, production writes, authenticated live-device probes, Windows
builds, installer packages or customer-device tests were performed.
