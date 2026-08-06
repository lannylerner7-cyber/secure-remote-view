# Native Admin token/curtain fix — verification result

I read the admin source directly. All four items from your write-up are present and the console builds clean. Below is the evidence, then the one small gap I found.

## Verified in code

**1. Token stays fresh (root cause)**
`Api/ApiClient.cs` has `StartTokenRenewal()` (line 59) running a timer that refreshes once the token is within 60s of `ExpiresAt`, `EnsureFreshTokenAsync()` (line 110) serialised behind a gate so concurrent 401 retries can't invalidate each other's refresh token, a `TokenChanged` event (line 36) fired on rotation (line 171), and `StopTokenRenewal()` on logout (line 177). `App.xaml.cs:95` starts renewal right after the client is constructed.

**2. Realtime is token-aware**
`Media/RealtimeChannel.cs` no longer holds a captured token: it takes `Func<string?> tokenProvider` (line 40) read at every join (line 269). `UpdateToken()` (line 124) pushes the Phoenix `access_token` event to each joined topic — tracked in `_joinedTopics` (line 290) — so a rotation costs no reconnect. A join rejection matching `IsExpiredTokenError` (line 216) forces a refresh and retries at the fast rung instead of burning backoff.

**3. Quieter, honest status**
The amber banner only fires after three consecutive failures (line 226); an expired-token retry that succeeds is silent. `LiveSessionViewModel` clears any stale `Realtime:` message when the socket recovers. In `Views/LiveSessionWindow.xaml` both banners are `DockPanel.Dock="Top"` above the picture, so nothing overlays the remote desktop.

**4. Curtain parity**
`LiveSessionViewModel.cs:552` sends the 1s dead-man `curtain_on` through `InputTransport` (datachannel first, REST fallback), matching the web console. `curtain_off` / `release_inputs` stay REST-only on teardown, deliberately.

**Wiring and lifetime:** the view model passes the provider and `EnsureFreshTokenAsync` into the channel, subscribes `TokenChanged`, and unsubscribes in `Stop()` so a closed session leaks nothing.

**Build:** .NET 8 Windows-targeted Release build of `ConnectLiveAdmin.csproj` — 0 errors. `PROJECT-MAP.md` §10.35 records the token invariant. Refreshed archives are already cut as `2026-08-06`.

## One gap worth closing

`RealtimeChannel.RunAsync` line 178 refreshes before joining only when the token is null or empty. A token that exists but is seconds from expiry still gets used for the join, so that attempt can be rejected and cost one reconnect cycle before the retry path recovers it. The renewal timer normally prevents this, but a laptop resuming from sleep hits exactly this window: the timer thread wakes late and the socket reconnects first.

**Proposed change (one file):** in `Api/ApiClient.cs`, add a cheap `bool TokenExpiringWithin(int seconds)` read off `AuthStore`. In `RealtimeChannel.RunAsync`, change the pre-join guard to call the refresh when the token is missing *or* expiring within ~60s. No behaviour change on the happy path; it just removes the guaranteed-rejected join after a resume.

Nothing else changes — no server, agent, database, or web-console edits. After the change I would rebuild and recut the two Admin archives.

## If you'd rather not

The current code already recovers from that case within one retry (about a second), so skipping this is reasonable. Say the word and I'll leave the code as verified.
