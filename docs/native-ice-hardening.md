# Native ICE hardening

## Behavior

- Agent and Admin use a **12-second total ICE lookup budget**, linked to the
  session/negotiation cancellation token. This allows the gateway's five-second
  provider deadline plus authentication and fallback work; it is not a fixed
  startup delay.
- Both send the current session ID to
  `/api/public/agent/ice?sessionId=...` (URI escaped). Gateway authorization
  remains authoritative; no grants or entitlements were expanded.
- Agent no longer caches a session-wide warmup task or ICE configuration.
  Every offer, including same-technician restart and takeover, fetches fresh
  configuration before constructing a fresh peer. Consequently no cached TTL
  can expire between allocations, and initial STUN-only fallback is retried
  on the next offer. There is no background mint/retry loop and an established
  peer is not forcibly disconnected at credential expiry.
- On gateway failure/lookup deadline, direct-only STUN fallback remains.
  Authorization is checked before lookup and after awaiting it; cancelled or
  locally revoked sessions cannot create a peer. HTTP 401/403 does not become
  a usable fallback. Agent ICE cannot silently re-enroll on 401. Admin retains
  its existing refetch-on-negotiation behavior.
- Agent peer callbacks are bound to the peer/admin that created them so an
  obsolete peer's close/candidate events cannot damage a replacement.

## Deployment configuration

Both native clients validate configured API origins as HTTPS, with no
credentials, query, fragment or non-root path. Admin also validates its
Supabase origin. The API clients and Agent's separate SSE transport disable
automatic redirects (even same-origin); configure the final HTTPS origin.
No device/bearer/refresh token is forwarded to redirect destinations.

Admin no longer has an embedded Supabase account fallback. The source
`admin.config.json` uses the user-confirmed `https://connectliveagent.com` base URL;
its required Supabase values remain empty. Deployment
administrators must provide `baseUrl`, `supabaseUrl`, and `supabaseAnonKey`
(publishable key, never service-role credentials) before shipping/installing.
The existing executable-directory-first, then
`%AppData%\ConnectLiveAdmin\admin.config.json` lookup order is preserved.
Missing or invalid settings produce an actionable startup dialog; no new
configuration UI or account settings have been embedded. Browser configuration
UI is untouched.

## Portable checks and cross-build evidence

Commands from repository root:

```sh
dotnet run --project agent/src/Tests/NativeGatewayTests.csproj
dotnet build agent/src/ConnectLiveAgent.csproj -p:EnableWindowsTargeting=true
dotnet build admin/src/ConnectLiveAdmin.csproj -p:EnableWindowsTargeting=true
```

The portable net8.0 test executable links the actual shared native transport
policy and Admin configuration class; it has no WPF or third-party test-package
dependency. **22 checks passed**, covering unsafe origins, origin
canonicalization, required/escaped session ID, absent account defaults,
required publishable key, a real socket cross-origin HTTP 307 with device and
bearer headers (no destination request), a simulated 5.2-second provider/fallback
response, caller cancellation, and the actual 12-second deadline duration.
HTTP loopback is used only in the redirect test, not allowed by production
origin validation. Delay responses are test doubles, not production data.

Both explicit csproj builds succeeded on Linux with .NET SDK 8.0.416:
Agent **0 errors / 3 warnings** (two existing async-without-await warnings and
DPI manifest warning); Admin **0 errors / 6 warnings** (existing nullable file
transport and DPI warnings, counted across WPF intermediate/final compilation).
An initial `--no-restore` Agent attempt failed due to missing Windows runtime
packs; the normal builds restored those dependencies successfully. Both
projects now explicitly set `EnableWindowsTargeting=true`.

## Limits

Portable checks exercise transport/configuration policy, not SIPSorcery,
Windows UI, the full permission lifecycle or gateway role/session enforcement.
The native applications were cross-compiled, not launched. No installer was
published and no credentials, account configuration or binary artifacts were
added. Two authorized Windows machines are still needed to verify direct and
forced relay, offer-to-first-frame time, slow gateway cancellation, local
revocation, takeover, reconnect after initial fallback, and long-session
credential rollover. STUN fallback is not proof of relay/media connectivity.
