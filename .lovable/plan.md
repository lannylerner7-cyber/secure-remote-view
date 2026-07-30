## Verified before planning

- `power_commands_kind_check` already allows `wake`, `wake_agent`, `reboot`, `shutdown`, `lock`, `logoff` — no migration needed, and the blind one would have wiped three kinds.
- `power_commands` RLS: all three policies are `TO authenticated` and gated on `has_role(auth.uid(), ...)`. There is **no** anon path.
- `supabase_realtime` publication currently contains `sessions` only; `power_commands` is not published, and its replica identity is `default`.

That last point decides the architecture. A direct Supabase Realtime socket from the Watcher would need a Supabase JWT on the machine. The Watcher only holds a DPAPI device token — so we'd have to either ship the publishable key plus an `anon` SELECT policy on `power_commands` (leaks every device's command queue to anyone with the key), or mint per-device Supabase JWTs on-box. Both are worse than the goal.

Instead we get the same millisecond wake with a **server-pushed stream on our own gateway**, authenticated by the device token that already exists.

## Part 1 — Instant wake channel (push instead of poll)

1. **New route `src/routes/api/public/agent/stream.ts`** — a long-lived SSE endpoint.
   - Authenticates with the existing `verifyDevice(request)` (same `X-Device-Id`/token headers as heartbeat), so no new credential lands on the endpoint machine.
   - Holds the connection open and emits `wake`, `power`, and `session` events as they appear; sends a `ping` comment every 20s to keep intermediaries from closing it.
   - Server-side it subscribes to Postgres changes for that device: publish `power_commands` and set `REPLICA IDENTITY FULL` (migration), then a server-held Supabase client filtered to `device_id=eq.<id>` fans events into the SSE stream. The database credential stays server-side.
   - Marks delivered commands `dispatched` exactly as heartbeat does, so ack semantics are unchanged.
   - Caps stream lifetime (~10 min) and instructs the client to reconnect, so no connection leaks on the worker.

2. **`agent/watcher/Program.cs`** — event-driven with REST as the floor, not the ceiling.
   - New `StreamLoop`: opens the SSE connection, parses events line-by-line, and on `wake_agent` calls the existing `LaunchInSession` path immediately, then acks via `/api/public/agent/power/{cmdId}/ack`.
   - Heartbeat loop stays but relaxes to a 60s steady cadence while the stream is healthy (it still refreshes `last_seen_at` so the console's online dot is correct), and snaps back to the current 5→10→20→30s back-off the moment the stream drops.
   - Reconnect with jittered back-off (1s → 30s cap) so a gateway blip doesn't stampede.
   - Reuse the existing PID tracking / `MinRelaunchInterval` guard so a stream-triggered wake can't spawn-storm either.
   - Event-log every wake decision with its source (`stream` vs `heartbeat`) for on-machine diagnosis.

3. **Idempotency.** A command can arrive on both the stream and the next heartbeat. The Watcher keeps a small set of recently handled command IDs and drops duplicates.

## Part 2 — Admin console error handling (from the prior plan, unchanged)

4. **`admin/src/ViewModels/LiveSessionViewModel.cs` / `DevicesViewModel.cs`** — clear the error banner on the next successful call of the same kind, and auto-expire non-fatal banners after ~15s, so a one-off failure stops looking like a permanent broken state.
5. **`DevicesViewModel.Connect`** — the `wake_agent` enqueue currently swallows all exceptions. Log the PostgREST body to `%AppData%\ConnectLiveAdmin\admin.log` and show a soft "Wake not queued — relying on session flip" note instead of a red HTTP 400.
6. **`src/routes/_authenticated/console.tsx`** — `requestReconnect` wake enqueue failure becomes a soft toast, not a hard error.

## Part 3 — Guardrail

7. **`scripts/verify-agent-routes.ts`** — assert every `kind` the clients enqueue is present in the live `power_commands_kind_check`, and that `/api/public/agent/stream` is registered. A future narrowing migration then fails verification instead of surfacing as a runtime 23514.

## Part 4 — Repackage

8. Rebuild `ConnectLive-RemoteAgent-src.zip` (watcher) and `ConnectLive-AdminConsole-src.zip` (admin).

### Technical notes

- One migration only: `ALTER PUBLICATION supabase_realtime ADD TABLE public.power_commands;` and `ALTER TABLE public.power_commands REPLICA IDENTITY FULL;`. No constraint edit, no new table, no new grants or policies — the stream reads server-side with service credentials.
- SSE over plain HTTPS traverses corporate proxies far more reliably than a raw WebSocket, which matters for a LocalSystem service on managed endpoints.
- Expected wake latency after this: sub-second while the stream is up, worst case 60s if the stream is blocked and it falls back to heartbeat — versus up to 60s today in the common case.
