## Fix admin "column session_frames.jpeg_base64 does not exist"

### What's actually going on

The proposed master SQL script would mostly no-op against the current DB, and the one part that isn't a no-op would make things worse:

- `session_frames.jpeg_base64` — **does not exist, and shouldn't be added.** The agent already uploads base64 JPEGs into an existing column named `frame` (see `src/routes/api/public/agent/session/$sessionId/frame.ts`, which upserts `{ session_id, frame, width, height }`). The web console reads `frame` too. The 400 is the C# `FrameFallbackPump` querying the wrong column name.
- `sessions.admin_client_id` — already exists.
- `session_signals.admin_client_id` — already exists.
- `power_commands` table + indexes — already exist (created in the Wake-on-LAN turn).

Adding `jpeg_base64` on top of `frame` would leave two columns for the same data: the agent keeps writing `frame`, the admin keeps reading an always-NULL `jpeg_base64`, and the fallback silently shows a black screen instead of a 400 — worse than the current banner.

### Fix (admin C# only, no migration)

Point `ApiClient.GetLatestFrameAsync` at the real column.

**`admin/src/Api/ApiClient.cs`** — in `GetLatestFrameAsync`:

- Change the query from
  `session_frames?select=jpeg_base64,captured_at&...&order=captured_at.desc&limit=1`
  to
  `session_frames?select=frame,updated_at&...&order=updated_at.desc&limit=1`
  (the table's ordering column is `updated_at`, not `captured_at`).
- Read `frame` (not `jpeg_base64`) from the JSON response; keep the existing base64 → byte[] decode.

That's the entire code change. No schema migration, no new column, no new indexes.

### Why not just run the user's script anyway

`ADD COLUMN IF NOT EXISTS` is safe in the "won't error" sense, but it isn't free:

- `session_frames.jpeg_base64` would ship a permanent dead column that masks the real bug.
- The three "already exists" statements are pure noise in the migration history.
- The indexes on `power_commands` / `sessions` / `session_signals` are already in the schema from earlier turns; re-adding them would be a no-op and clutter.

If a later audit shows any of those indexes are genuinely missing, we can add just those in a targeted migration — not bundle them behind a wrong column fix.

### Verification after the change

1. Rebuild `ConnectLiveAdmin`.
2. Sign in as `197200`, connect to a live device.
3. Orange banner "column session_frames.jpeg_base64 does not exist" is gone.
4. While transport shows `http-poll`, the live view renders the agent's JPEG frames; it flips to `webrtc` once negotiation completes.
