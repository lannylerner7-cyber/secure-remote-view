# Native Admin: expired-token Realtime failure + curtain parity check

## What the screenshot actually shows

The amber banner reads:

```text
Realtime: join rejected: {"reason":"InvalidJWTToken: Token has expired 260 seconds ago"}
```

That is not a curtain bug and not an agent bug. It is the console's technician
sign-in token going stale mid-session.

Confirmed by reading the code this session:

- `ViewModels/LiveSessionViewModel.cs:218-221` builds `RealtimeChannel` with a
  **snapshot** of `App.Auth.Current?.AccessToken`. The field is `readonly`
  (`Media/RealtimeChannel.cs`) and is re-sent verbatim on every reconnect, so
  once the token expires the reconnect ladder retries forever with the same
  dead token.
- There is no background refresh anywhere. `ApiClient.RefreshSessionAsync`
  exists but is only called on app start (`App.xaml.cs:132`) and reactively
  after a REST 401 (`Api/ApiClient.cs:190`). Nothing renews the token on a
  timer, so a session open longer than the token lifetime loses Realtime.
- The web console does not have this problem because supabase-js refreshes the
  token and pushes it onto the socket automatically.

Effect: video keeps working (the HTTP poll pumps are the fallback), but the
push path dies, latency goes up, and the alarming amber banner covers the top
of the remote desktop.

## Curtain: web vs native

I compared both paths line by line. They already match:

| | Web (`_authenticated/console.tsx`) | Native (`LiveSessionViewModel.cs`) |
|---|---|---|
| Toggle | update `sessions.mode` + insert `curtain_on`/`curtain_off` | `SetSessionModeAsync` + `PushInputAsync` same kinds |
| Dead-man ping | `curtain_on` every 1s | `curtain_on` every 1s |
| Release | on unmount / tab hidden | on window close / reconnect |
| Label | "Curtain (take control)" / "Release curtain" | identical |

The one real difference: the web console sends `curtain_on` **RTC-first**
(datachannel, REST fallback), while the native heartbeat always goes over REST.
With an expiring token and a slow link, those REST pings are the first thing to
stall — and a missed 5s window makes the agent auto-release the curtain, which
is exactly the "curtain feels off" symptom.

## What will change

**1. Keep the technician token fresh (root cause)**
- Add a background renewal loop in `ApiClient`: refresh when the token is
  within ~60s of `ExpiresAt`, plus an immediate refresh if it is already
  expired. Expose a `TokenChanged` event.

**2. Make Realtime token-aware**
- Replace `RealtimeChannel`'s readonly `_accessToken` with a token *provider*
  callback, so each join and reconnect picks up the current token.
- Add `UpdateToken(string)`, which sends Phoenix `access_token` on the live
  socket when the token rotates (no reconnect needed).
- On a join rejection whose reason contains `InvalidJWTToken` / `expired`,
  force a refresh first and retry immediately instead of counting it as a
  normal backoff failure.

**3. Quieter, honest status**
- Token-expiry reconnects that succeed on retry should not raise the amber
  banner at all; only a persistent failure surfaces it, and the banner moves
  out of the video grid so it never covers the remote desktop.

**4. Curtain heartbeat parity**
- Route the native `curtain_on` dead-man ping through `InputTransport`
  (datachannel first, REST fallback), matching the web console, so the curtain
  no longer depends on REST round-trips alone.

## Technical notes

- Files: `admin/src/Api/ApiClient.cs`, `admin/src/Api/AuthStore.cs` (read-only
  helper for expiry), `admin/src/Media/RealtimeChannel.cs`,
  `admin/src/ViewModels/LiveSessionViewModel.cs`, and a small banner placement
  change in `admin/src/Views/LiveSessionWindow.xaml`.
- No server, agent, database, or web-console changes. The agent side in the
  screenshot is behaving correctly.
- `PROJECT-MAP.md` gets a short entry recording the invariant: any long-lived
  socket in the native console must read the token through the provider, never
  capture it.
- Verification is a Windows build; after the fix I can recut the Admin
  archives if you want them refreshed.
