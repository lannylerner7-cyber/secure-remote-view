## What I found

- **Telegram**: `src/lib/notify.functions.ts` is wired and RLS-scoped to the signed-in admin, with settings in `admin_settings`. Console fires `session_start`, `session_end`, `control_taken` and a test message — but **`device_offline` is never fired anywhere**, even though the toggle exists in the UI. Also failures are silent (no toast when the bot token is wrong/muted).
- **Endpoints**: every URL the C# clients call resolves to a real route file (enroll, hello, heartbeat, power ack, session consent/reconnect/frame/cursor/inputs/signal, auth/login, stream). One stale reference: `ApiClient.cs` still mentions the retired `api/public/agent/pair`.
- **Icons**: **`assets/icon.ico` does not exist anywhere in the repo.** Both csproj files, `AppIcon.cs`, both `build.ps1`, and the Inno `SetupIconFile` all reference it conditionally, so builds silently fall back to the default .NET icon. Only `agent/assets/logo.svg` exists.
- **Zips**: `public/` currently holds v1.1 admin and v1.2 agent source zips.

## Plan

**1. Ship a real icon.ico**
- Generate a multi-size (16/32/48/64/128/256) `icon.ico` from the ConnectLive brand mark and commit it to `agent/assets/icon.ico` and `admin/assets/icon.ico`.
- Verify the existing wiring now activates: agent `<ApplicationIcon>`, admin `<ApplicationIcon>` + `<Resource>` (taskbar/window via `AppIcon.Apply`), Inno `SetupIconFile` + `UninstallDisplayIcon`, and both `build.ps1` staging steps. No warning paths should trigger anymore.
- Also emit a matching `public/favicon.ico` so the web console matches the desktop apps.

**2. Telegram verification pass**
- Wire the missing **`device_offline`** notification: fire once per device when the console's device poll flips a device from online to offline (dedupe so it doesn't spam every poll tick).
- Surface send results: the "Send test" action already reports; make the background sends log the `not_configured` / `muted` / `provider_error` reason to console so a misconfigured bot is diagnosable.
- Keep everything on the caller's own bot token — no shared secret.

**3. Endpoint audit deliverable**
- Add `ENDPOINTS.md` at the repo root: one row per `api/public/*` route with method, auth model, caller (agent / admin / web / external), and status verified.
- Delete the stale `agent/pair` comment in `ApiClient.cs`.

**4. Live view display clean-up (console + native admin)**
- Remove leftover consent/tray-era chrome from the live view header, keep curtain + live indicator only.
- Letterbox the frame correctly (`object-contain`, no stretch) and render at the frame's native resolution so the 1920px-edge capture isn't downscaled twice; keep the cursor SVG overlay aligned to the same scale factor.
- Keep the transport health pill.

**5. Repack**
- Rebuild both source zips with new version stamps: `ConnectLive-RemoteAgent-src-v1.3-<date>.zip` and `ConnectLive-AdminConsole-src-v1.2-<date>.zip`, mirrored to `public/` and `/mnt/documents/`, with the download links on the public page updated to the new filenames.

## Technical notes

- The icon is a real binary committed to the repo (not a Lovable asset pointer) because MSBuild `<ApplicationIcon>` and Inno `SetupIconFile` need a file on disk at build time.
- `device_offline` detection stays client-side in the console poll loop; no new table or trigger, so no migration is needed.
