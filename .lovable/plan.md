
## Diagnosis: the source is already correct — the running .exe is stale

I audited every `session_frames` reference in the codebase against the actual DB schema. The string `jpeg_base64` does not exist anywhere in the repo — not in `admin/`, not in `agent/`, not in `src/`. The only frame-column references are:

| File | Columns read/written |
| --- | --- |
| `admin/src/Api/ApiClient.cs:253` (GetLatestFrameAsync) | `frame, updated_at` ✅ |
| `admin/src/Media/FrameFallbackPump.cs` | consumes bytes from above ✅ |
| `src/routes/_authenticated/console.tsx:145` | `frame, width, height, updated_at` ✅ |
| `src/routes/api/public/agent/session.$sessionId.frame.ts:41` | upserts `session_id, frame, width, height, updated_at` ✅ |

DB schema for `session_frames`: `session_id, frame, width, height, updated_at` — matches all code. No column is missing.

The orange banner text `column session_frames.jpeg_base64 does not exist` is coming from an **old `ConnectLiveAdmin.exe`** built before last turn's fix landed. The current source in `admin/src/Api/ApiClient.cs` already queries `select=frame,updated_at` — the compiled binary on disk still has the pre-fix query.

## Full column audit (code ↔ DB) — no gaps

I cross-checked every `.from("...")` call site in both `admin/` (REST paths) and `src/` (Supabase client) against the schema in `<supabase-tables>`. Every column referenced exists:

- `devices`: id, device_id, display_name, hostname, os, last_seen_at, status, is_session_active, metadata, standing_consent — all present.
- `sessions`: id, device_id, technician_id, mode, state, pairing_code, admin_client_id, ended_at, created_at — all present.
- `session_signals`: id, session_id, from_side, kind, payload, admin_client_id — all present.
- `session_frames`: session_id, frame, width, height, updated_at — all present.
- `session_cursors`, `session_inputs`, `power_commands`, `orders`, `plans`, `admin_wallets`, `admin_settings`, `notifications`, `audit_logs`, `user_roles`, `profiles`, `license_lookups`, `payment_events` — every referenced column exists.

No migration is required. Adding a `jpeg_base64` column would be actively harmful: the agent writes `frame`, so `jpeg_base64` would always be NULL and the fallback would silently show black instead of failing loudly.

## Plan

1. Don't change source — it's already correct.
2. Rebuild the admin bundle from the current tree and repackage `ConnectLive-AdminConsole.zip`, so the shipped `.exe` contains the `frame,updated_at` query.
3. Repackage `ConnectLive-RemoteAgent.zip` alongside it for parity (no code change; keeps the two zips version-matched).
4. Deliver both zips. After replacing the old `ConnectLiveAdmin.exe`, the orange banner disappears; fallback frames render while `http-poll` is active, then transport flips to `webrtc` once negotiation completes.

If you'd rather not re-download, the equivalent local fix is: `dotnet publish admin/src/ConnectLiveAdmin.csproj -c Release -r win-x64 --self-contained` and replace the old binary with the new one from `bin/Release/net8.0-windows/win-x64/publish/`.
