## Answer: which client routes need no changes

I checked every endpoint string in `agent/src`, `agent/watcher`, and `admin/src` against the actual files in `src/routes/api/public/agent/`.

### Agent client (`agent/src`) — no route changes needed
All 10 calls map 1:1 to a mounted backend route:

```text
POST /api/public/agent/enroll                     -> enroll.ts
POST /api/public/agent/hello                      -> hello.ts
POST /api/public/agent/heartbeat                  -> heartbeat.ts
POST /api/public/agent/power/:id/ack              -> power.$cmdId.ack.ts
POST /api/public/agent/session/:id/consent        -> session.$sessionId.consent.ts
POST /api/public/agent/session/:id/reconnect      -> session.$sessionId.reconnect.ts
POST /api/public/agent/session/:id/frame          -> session.$sessionId.frame.ts
POST /api/public/agent/session/:id/cursor         -> session.$sessionId.cursor.ts
GET  /api/public/agent/session/:id/inputs         -> session.$sessionId.inputs.ts
GET|POST /api/public/agent/session/:id/signal     -> session.$sessionId.signal.ts
```
The new `stream.ts` (SSE) is consumed by the **watcher**, not the agent worker — correct by design, since the watcher is the one that must wake a closed agent.

### Watcher (`agent/watcher`) — already updated, no further route work
Uses `/enroll`, `/heartbeat`, `/power/:id/ack`, and the new `GET /api/public/agent/stream`. All four exist.

### Admin client (`admin/src`) — no route changes needed
The admin console never touches `/api/public/agent/*`. It talks to PostgREST directly (`/rest/v1/...`, `/rest/v1/rpc/bind_admin`) plus the auth login route. Nothing in the SSE work altered those surfaces; the only admin change was the auto-clearing error banner in `LiveSessionViewModel.cs`.

## The one real gap

`scripts/verify-agent-routes.ts` still defaults `BASE` to `https://secure-remote-view.lovable.app`, while both clients now point at `https://zoomlite.live`. That makes the smoke check verify the wrong deployment.

## Proposed work

1. Change the default `BASE` in `scripts/verify-agent-routes.ts` to `https://zoomlite.live` (still overridable via env).
2. Run the smoke check against the live domain and report the pass/fail table for all 11 agent routes + login.
3. Repackage both source archives so the zips carry the SSE watcher loop and the admin banner fix:
   - `ConnectLive-RemoteAgent-src.zip`
   - `ConnectLive-AdminConsole-src.zip`

No C# route strings change on either side.
