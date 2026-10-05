# ConnectLive Roadmap — Android Agent & Platform Separation

Status legend: `[x]` done · `[~]` in progress · `[ ]` not started.

The Windows agent (`agent/`, C# .NET 8) is production. The Android agent
(`android-agent/`, Kotlin, **not yet in the repo**) is a second, parallel
client. Both talk to the **same backend, same signalling, same TURN** — but
they are **different device kinds** and must never be confused by the server,
the admin console, or the native Admin client. The rules in §4 are how we
keep the wires from crossing.

---

## 1. Shared backend contract (already shipped — do not change for Android)

| Capability | Route / table | Notes |
| --- | --- | --- |
| Enrollment | `POST /api/public/agent/enroll` | Already accepts `os` in the body and writes `devices.os`. Android sends `os: "android"`. No schema change needed. |
| Device auth | `X-Device-Id` + `X-Device-Token` (SHA-256 hash in `devices.metadata.token_hash`) | Reused verbatim. Token minted server-side, stored client-side in Android Keystore (equivalent of DPAPI). |
| Presence | `POST /api/public/agent/heartbeat` | Same cadence rules. Android reports battery + screen-locked flag inside `metadata`. |
| Wake | `GET /api/public/agent/stream` (SSE) | Reused. Android holds the SSE open inside its ForegroundService. |
| Signalling | `POST`/`GET /api/public/agent/session/{id}/signal` | Reused unchanged. `admin_client_id` isolation already in place. |
| ICE | `GET /api/public/agent/ice` | Cloudflare Calls TURN works for Android with no change. |
| Beacon | `POST /api/public/agent/beacon` | Watch-app only. **Does not apply to Android** — Android cannot be "killed by Task Manager"; see §4.4. |

---

## 2. Android agent — processes to build

Target: `android-agent/` (Kotlin, min SDK 29, target SDK 34).

### 2.1 Capture & encode
- [ ] `MediaProjectionService` — foreground service; retains the projection
  token across the whole session so the OS prompt only appears once (standard
  devices) or never (Device Owner mode).
- [ ] `MediaCodec` H.264 encoder on the GPU silicon. VP8 fallback for devices
  where H.264 hardware is absent. Mirrors the Windows `HwH264Encoder` / VP8
  policy so the admin side's codec negotiation is unchanged.
- [ ] Portrait + landscape surface rotation, reported in the SDP so the
  Admin client can lock aspect.

### 2.2 Transport
- [ ] WebRTC peer (libwebrtc Android build) using the exact ICE server set
  returned by `/api/public/agent/ice`.
- [ ] `inputs` DataChannel: receives normalised coordinates (0.0–1.0) and
  the same closed set of event kinds the Windows `InputRelay` accepts
  (see §4.2). Payload schema is **the same JSON**; semantics differ.
- [ ] `files` DataChannel: reuses the AES-GCM 64 KB chunk + SHA-256 scheme
  from `agent/src/FileTransfer.cs`. HTTP fallback via
  `/api/public/agent/session/{id}/file` is unchanged.

### 2.3 Input injection
- [ ] `AccessibilityInputService` — the only Android API that can inject
  touch gestures without root. Translates:
  - `mousemove` / `click` / `mousedown` / `mouseup` → `dispatchGesture`
    (tap, long-press, drag).
  - `wheel` → two-finger scroll gesture.
  - `key_sequence` / `unicode_text` → `performGlobalAction` for system keys,
    IME-based text insertion for text.
- [ ] Reject any kind the Android handler does not understand. Do **not**
  silently fall back to a different action; log and drop. (Same guardrail
  as `agent/src/InputRelay.cs` on Windows — see AGENTS.md.)

### 2.4 Curtain mode
- [ ] `CurtainService` using `SYSTEM_ALERT_WINDOW` /
  `TYPE_APPLICATION_OVERLAY`.
- [ ] Local bundled GIF (`R.raw.curtain_default`) draws instantly; optional
  remote URL override from the admin's curtain message. The URL override
  is purely cosmetic — the overlay is already up before the download
  starts, so the screen is never exposed.
- [ ] Curtain on/off messages ride the existing `inputs` DataChannel with
  kinds `curtain_on` / `curtain_off` (already in the Windows allow-list).

### 2.5 Remote restart
- [ ] Admin sends `{ "kind": "restart" }` on the control channel.
- [ ] Agent schedules an `AlarmManager` relaunch 1 s in the future, posts a
  "restarting" beacon on heartbeat, then `System.exit(0)`. The alarm fires
  and the ForegroundService re-registers. There is **no watcher process**
  on Android — the OS forbids one app spawning another, and the alarm is
  the sanctioned replacement.

### 2.6 Device Owner / MDM provisioning (optional but recommended)
- [ ] Ship a `DeviceAdminReceiver` so enterprise fleets can run
  `adb shell dpm set-device-owner com.connectlive.agent/.receiver.DeviceAdminReceiver`
  once at provisioning. Unlocks: silent screen-capture permission,
  `DevicePolicyManager.reboot()`, uninstall protection
  (`setUninstallBlocked = true`), battery-exemption.
- [ ] QR-provisioning payload documented in `android-agent/INSTALL.md`.

### 2.7 Packaging
- [ ] Gradle build producing a signed APK + AAB.
- [ ] Release channel entry in `public.releases` with `product = "android"`
  so `/api/public/agent/release?product=android&channel=stable` serves the
  manifest alongside `agent` and `admin`. No new route — just a new row
  type.

---

## 3. Admin surface — what changes

- [ ] `src/components/console/DevicesTable.tsx`: show a small platform badge
  (Windows / Android) sourced from `devices.os`. Already available, just
  render it.
- [ ] Native Admin client (`admin/`): when the incoming track reports a
  portrait resolution, lock the viewport to portrait and scale touch
  coordinates accordingly. No new transport, just a layout branch in
  `D3DImageHost` / `LiveSessionWindow`.
- [ ] Power menu: hide **Wake-on-LAN** and **Shutdown/Restart via SYSTEM
  service** for Android rows. Show **Restart app** (sends the §2.5
  message) and, when the device is Device Owner, **Reboot device**
  (invokes `DevicePolicyManager.reboot()` on the agent side). Hiding
  happens in `src/components/console/PowerMenu.tsx` keyed on `device.os`.

---

## 4. Keeping the Windows and Android wires from crossing

These are the invariants. Every new piece of code must respect them.

### 4.1 Platform discriminator = `devices.os`
Every server route and every admin UI branch that behaves differently per
platform reads **`devices.os`** (values: `windows`, `android`; anything else
is treated as `windows` for back-compat with pre-Android rows). Never
sniff user-agent, never guess from hostname.

### 4.2 Input schema: same wire, platform-specific executor
The JSON on the `inputs` DataChannel is identical. The *executor* differs:

- Windows → `agent/src/InputRelay.cs` (SendInput).
- Android → `AccessibilityInputService.dispatchGesture`.

Both executors share the same allow-list and clamping (mouse 0–1, rel ±500,
wheel ±1200, button 0–2, vk 1–254, text ≤256 chars, key sequences ≤32
events). Unknown kinds are dropped on both sides. This guardrail is
non-negotiable — see AGENTS.md and the custom-instruction in context.

### 4.3 Power commands are not interchangeable
`power.$cmdId.ack` already queues commands. The queue entry carries a
`kind` field. Allowed kinds per platform:

| Kind | Windows | Android |
| --- | --- | --- |
| `restart` (OS reboot) | yes (SYSTEM service) | **only if Device Owner** |
| `shutdown` | yes | no |
| `wake` (WoL) | yes | **no** (Android has no WoL target) |
| `restart_stream` | yes | yes |
| `switch_monitor` | yes | **no** (Android is single-display) |
| `restart_app` | yes | yes |

The server rejects a kind that is not in the target platform's column with
HTTP 409 `unsupported_for_platform`. This stops a tech from accidentally
sending a Windows-shaped command to a phone and vice versa.

### 4.4 No Watch beacon on Android
`ConnectLiveWatch.exe` + `/api/public/agent/beacon` exist because Windows'
Task Manager can `TerminateProcess` the agent with no cleanup. Android's
OS kill paths already notify the ForegroundService (`onDestroy`), and
sideloading a second "watcher" app is both pointless and against Play
policy. On Android the agent itself posts a `reason: "stopping"` beacon
during `onDestroy`; no second process.

### 4.5 Release manifest is per-product
`public.releases.product` already distinguishes `agent` vs `admin`. Android
adds `android` as a third value. The agent never pulls an Android APK and
the phone never pulls an `.exe`. The route enforces this in the handler
(`product` is validated against a fixed enum).

### 4.6 Session rows carry the platform at creation
`sessions.device_id → devices.id → devices.os`. The admin UI reads the
platform via a join, so there is no duplicated column to drift. Any
platform-conditional server logic (e.g. the §4.3 command validator) does
the same lookup.

### 4.7 Signalling isolation is already handled
`session_signals.admin_client_id` isolation (see
`src/routes/api/public/agent/session.$sessionId.signal.ts`) applies without
change — it has nothing to do with platform. An Android agent and a
Windows admin peer each have exactly one `admin_client_id` on their
session; cross-pollution is impossible.

### 4.8 TURN credentials are per-request
`/api/public/agent/ice` mints Cloudflare Calls creds per call. The Android
peer calls the same endpoint; nothing to split.

---

## 5. Open items & sequencing

1. [ ] Scaffold `android-agent/` (Gradle, Kotlin, min SDK 29) with the four
   services from §2.1–2.4 as empty classes + a working ForegroundService
   notification. Nothing streams yet.
2. [ ] Wire enrollment, heartbeat, SSE wake. Verify a phone shows up in
   the console with an "Android" badge and goes online/offline cleanly.
3. [ ] WebRTC loopback: get a peer connection + the `inputs` DataChannel
   up without video. Prove the §4.2 schema parity by sending a known
   payload from the Admin client.
4. [ ] MediaProjection + MediaCodec H.264. Prove it decodes in the native
   Admin's existing H.264 pipeline (no admin-side code change required
   beyond the portrait viewport lock in §3).
5. [ ] AccessibilityInputService: tap, swipe, scroll, text. Test on a
   stock Pixel first, then on a Device Owner-provisioned test device.
6. [ ] Curtain overlay (§2.4) with the bundled GIF.
7. [ ] Remote restart via `AlarmManager` (§2.5).
8. [ ] Release manifest row + install docs.
9. [ ] Update `PROJECT-MAP.md` with §10.38 (Android agent) and
   `ENDPOINTS.md` with the `product=android` note on
   `/api/public/agent/release`.

---

## 6. Non-goals

- No iOS agent. Apple blocks the equivalent of
  `AccessibilityService.dispatchGesture` on managed devices and we would
  only be able to view, not control.
- No daisy-chained video (Agent → Admin PC → Web). Doubles the tech's
  upload bandwidth and adds ~100 ms. The web console stays WebRTC-direct
  for triage; the native Admin stays the heavy rig.
- No browser-rendering fallback for desktop control. Cloudflare Browser
  Rendering is only ever used for background web diagnostics + PDF
  session reports.
