# Windows session tools: source handoff and acceptance

## Delivery boundary

This is a source-only update to the web console, Windows Agent and existing
Supabase application. No Windows executable, installed-client update or MSI
was built here. No shared database was changed, no GitHub push was made and
nothing was published. The native Admin source, physical-curtain implementation,
H.264 encoder, checkout and payment providers are not replaced.

The user's confirmed working curtain is the baseline, not an assertion of
multi-monitor or secure-desktop certification. See
[version-separated evidence](windows-session-tools-baseline.md).

The source retains the existing Agent version; the new negotiated
`session-tools-v1` / `files-v2` capabilities identify this source revision.
Do not label logs from older 1.10.12/1.10.13 runs as regressions in the confirmed
1.10.14 baseline, or treat encoder output counters as browser presentation.

## Verification status — 2026-11-15

| Check | Result |
| --- | --- |
| Focused production TypeScript/protocol/HTTP/storage/permission tests | 107 passed, including retired-peer receipt rejection |
| Approved development-only homepage deadline | 3 tests passed; absent from executable production bundles |
| Actual production C# policies, transfer code and orchestration, with platform adapters | 42 portable assertions passed |
| Additive session-tools SQL, disposable local PostgreSQL only | 25 assertions passed |
| Existing Windows-unlock SQL, disposable local PostgreSQL only | 33 assertions passed |
| Application TypeScript check | Passed |
| Production Node-preset application build | Passed |
| Combined browser pass | Passed one synthetic support-session journey using production tool components |
| Real Windows Hello, microphone, curtain and desktop transitions | **Not run here; explicitly authorized Windows machine required** |

After explicit approval, the homepage's development loader now stops waiting
after three seconds and shows the existing prices-unavailable state. The
managed preview starts and the homepage, health and isolated fixture endpoints
respond normally. The production bundle excludes this guard. Catalog values,
checkout and published pricing behavior were not changed.

Post-merge setup installs locked dependencies only. Its unconditional database
push was removed so this source-only merge cannot implicitly apply a schema
change; the additive migration still requires a separately approved target.

Portable compilation uses inert Windows UI/OS adapters where Linux cannot run
Windows APIs. It is not certification of native driver, helper or desktop behavior.

The browser pass checked exact `hello\n` download bytes, upload verification,
cancellation, checksum corruption, directory pagination/permission errors,
native-resolution 1280×720 PNG export, stale-frame refusal, curtain-preserving
pause, pending microphone cancellation, sharing receipts, local stop, consent
denial, on-device verification cancellation/unconfirmed completion, reconnect,
older-Agent handling and viewer denial. Phone-width and fullscreen menus were
usable; no browser console errors were captured.

This used synthetic role sign-in and transport/host adapters, **not** real
Supabase sign-in, a Windows host or a customer session. The browser confirmed
screenshot controls were disabled during verification; direct protected-export
guards and stale-peer receipts are covered by production-code tests, not a
second browser pass. A prior action's inline error can remain until the next
request, and cancelled file selections remain available for an explicit retry.
These do not resume operations or report incomplete success.

## What the new controls mean

### Windows verification

- **Unlock Windows** remains the existing already-signed-in, locked-session
  operation. It requires the trusted helper and existing explicit permissions.
  An unlocked desktop is **not** a wrong-PIN result.
- **App & browser verification** is a separate, bounded on-device approval
  interval. Choose autofill, saved-password access or passkey, and confirm that
  the owner requested this one interaction. The person uses the real Windows
  prompt locally. ConnectLive submits **no saved PIN** on this path.
- No supported integration currently binds a third-party browser's actual
  Windows-owned prompt, account, challenge and authentication result. Therefore
  there is deliberately no app/browser **Use saved PIN once** button. Window
  titles, coordinates and arbitrary focused password fields are insufficient.
- Cancel and **Finish on-device step** do not claim authentication success.
  The application result remains **unconfirmed**. Nothing retries automatically.
  The interval lasts at most two minutes, with a five-second current-peer lease.
- Explicitly turn the curtain off before on-device app approval. This path
  refuses an active curtain; it does not remove it implicitly. Completion,
  cancellation and reconnection leave input/control paused.
- Protected preparation stops microphone capture, files and recording. Ordinary
  input and clipboard are blocked. The existing lock-screen media restrictions
  remain in force; secure pixels are not routed through JPEG or recordings.
- The existing recording safety latch remains set after protected verification.
  Reload the live viewer before deliberately starting a new recording; no
  verification receipt starts recording or restores ordinary input.

Microsoft—not ConnectLive—decides Windows Hello and passkey authentication:

- https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello
- https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/
- https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows

### Optional owner setup

The optional setup appears after normal first-time pairing. **Skip** leaves
ordinary support available. Existing installations can explicitly open it:

```powershell
& "$env:ProgramFiles\ConnectLive\ConnectLive.exe" --session-tools-setup
```

The owner separately chooses microphone consent and up to eight ordinary-user
folders. Existing view/control/files grants acquire neither a microphone grant
nor arbitrary filesystem browsing. No privileged helper browses files.

Optional PIN setup reports local approval, helper installation, protected Agent
identity, encryption enrollment, saved credential, scenario support and
connectivity separately. Running from source/Downloads cannot impersonate a
trusted installation. Saving a PIN does not install or approve the helper.
Follow the manual installation and local approval sequence in
`imports/connectlive/docs/windows-unlock.md` first.

The owner types a new PIN themselves; no PIN is read from Windows or requested
in chat. It uses the existing device/grant/key-bound RSA-3072 + AES-GCM envelope
and DPAPI-protected private identity, not another persistent plaintext cache.
PIN entry is protected by a credential-free cross-process file lock: media and
ordinary remote actions remain blocked for the entire local setup window.
A stale marker after a crash is not considered active once its OS lock is gone.
This Windows sharing-lock behavior still needs the designated-device test.

Saving/replacing means **stored, not Windows-validated**. Web PIN settings retain
forget/revoke; `--unlock-disable` removes the local unlock identity and attempts
server revocation. Key rotation invalidates the old envelope. Device/grant
deletion cascades unlock access. Offline revocation cannot promise instant
remote erasure or erase backups.

To withdraw folder/microphone consent locally without expanding the general
pairing-only UI:

```powershell
& "$env:ProgramFiles\ConnectLive\ConnectLive.exe" --session-tools-disable
```

### Files

**Files** contains Browse remote files, Send files, Take screenshot and Transfer
history. Browse lists actual owner-approved Agent folders, not the technician's
local computer. Entries are paginated and explicitly selected; large transfers
use incremental hashing, bounded queues, acknowledgements and disk spooling.

- Roots reject traversal, ADS, UNC and reparse/junction escapes. Windows
  directory-handle pins prevent ancestor replacement while listing/reading.
  Selected files are opened once, revision-checked, hash-read and transferred
  from the same pinned handle with permission checks throughout.
- Limits remain **500 MiB per file / 5 GiB per session**. Durable reservations
  count both archived and direct transfers across peer/process replacement.
  Failed/uncertain reservations conservatively consume quota until session
  disposal; they are not silently released and reused as fresh writes.
- `files-v2` binds every control and binary chunk to one transfer and peer;
  length, sequence and SHA-256 must match before a terminal receipt. An end
  marker alone is never completion.
- HTTP part listing/read/assembly failures, missing parts or withdrawn
  authority do not publish a success manifest or delete recoverable parts.
  Duplicate writes are accepted only after matching existing bytes/metadata;
  uncertain completion is never automatically replayed through a fallback.
- Direct downloads are deliberate local browser saves, not server collection.
  History distinguishes **verified direct / not archived**, reserved/unconfirmed
  and archived files. Archived object manifests are created only after integrity
  confirmation. Browser downloads use OPFS where available; without it the
  bounded-memory fallback rejects files over 16 MiB rather than allocating
  hundreds of megabytes silently.
- A new web console requires the new Agent for verified direct transfers.
  Older Agents do not gain new privileges: the new controls report unavailable.
  Existing native Admin `files` framing is retained, with length checks, but its
  unchanged legacy receiver has no negotiated checksum terminal receipt. Do not
  call that legacy queued end marker a verified delivery. Native Admin source
  was not rewritten by this work.
- If there is no verified live channel, Send files may archive via HTTP only.
  The UI says **not delivered to the Windows device**; it does not queue a
  hidden delivery or replay it on reconnect.

### Screenshot

Take screenshot exports one PNG of the **actually presented** video/JPEG surface,
at its available native resolution, without DOM chrome or a local curtain
overlay. The still must be current (at most three seconds old), have dimensions,
and remain the same authorized session/controller/peer through asynchronous
encoding. Export uses the existing recording/capture permission and is blocked
for protected verification. It is not a recording or background collection.

### Microphone

This is the **Windows microphone**, not system loopback, webcam, the technician's
microphone or audio recording. Every peer starts Off. Listen requires separate
owner consent, a current server permission check and a real Agent receipt.

Only the Windows default **communications capture** endpoint is considered.
Its Core Audio form factor must be microphone/headset/handset, and its Windows
endpoint identity must match the opened WinMM device before capture starts.
Stereo Mix, line-level, unknown and unmappable drivers fail closed; select a
real default communications microphone in Windows. No automatic device switch
or display-name inference is used. Driver-reported identity/form-factor
compatibility still requires the authorized Windows tests below.

Reference: [Microsoft's documented legacy-audio endpoint identity mapping](https://learn.microsoft.com/en-us/windows/win32/coreaudio/device-roles-for-legacy-windows-multimedia-applications).

The Agent captures 8 kHz mono microphone PCM and sends standard PCMU through an
independently negotiated encrypted WebRTC audio track. It does not replace or
restart H.264/video/control to toggle audio. Capture queues are bounded to
short real-time frames; old samples are dropped. Sustained audio loss/jitter or
missing packets stops capture rather than building a backlog or restarting video.
The console's recording stream contains video only. No audio is stored server-side.

While active, the owner sees an excluded-from-capture microphone indicator,
including above a curtain. Its Stop control and physical **Ctrl+Alt+Shift+M**
stop capture; the hotkey remains available through the local input-blocking
hook. This active-audio indication is the explicit exception to the otherwise
pairing-only/no-general-tray UI.

Off stops the capture source, not merely playback. Pending Listen can be
cancelled before its receipt. Local stop, protected authentication, owner
withdrawal, permission loss, device/session removal and disconnect dispose the
source. No recovery or panel remount resumes it. If an Off receipt is unavailable,
the UI says unconfirmed; independent five-second leases fail closed.

## Backend and rollout gate

Prepared migration:
`imports/connectlive/supabase/migrations/20261115000000_session_tools.sql`.
It follows the reviewed browser-first/lifecycle/unlock migrations. It creates
private service-only transfer receipts, atomic quota/completion functions, and
an owner-enrollment envelope operation. It does not loosen the exact-key
five-capability version-1 grant parser or change database providers.

**No shared migration was applied.** Review and approve the target separately.
Deploying this source without that additive migration makes the new transfer
reservation/enrollment operations fail explicitly; saving a PIN or starting a
transfer must never pretend the schema exists. Do not apply it implicitly as a
test, source export or Windows installer step.

The existing heartbeat critical path keeps fresh runtime fencing, license and
grant checks. Independent mandatory work overlaps; genuinely optional command/
metadata reporting is bounded. A deferred command remains queued/dispatched
for the next read, not deleted or reported as delivered. Frame permission and
ownership checks overlap, but both must pass before storage. No authority
lease or timeout was enlarged to conceal a failure.

Diagnostics keep auth rejection, DNS/transport failure, gateway/server timing,
JPEG deadlines, signaling and encoder/decoder evidence distinct. A missing
diagnostic header is not proof the server never saw a request. Hardware H.264
and authorized latest-frame JPEG fallback remain; frame presentation callbacks,
not cursors or decoded-but-unpresented buffers, determine live-video evidence.
Diagnostics stay under the existing **?** popup.

## Reproducible checks

From the workspace root:

```sh
pnpm --filter tanstack_start_ts run typecheck
NITRO_PRESET=node-server pnpm --filter tanstack_start_ts run build
node --test tests/windows-unlock.cjs tests/control-curtain.cjs \
  tests/input-pause.cjs tests/media-recovery.cjs tests/jpeg-frame-recovery.cjs \
  tests/session-tools-ui.cjs tests/agent-http-diagnostics.cjs \
  tests/windows-session-tools.cjs tests/session-tool-permissions.cjs
node --test tests/home-preview-timeout.cjs
dotnet run --project tests/windows-session-tools/WindowsSessionTools.Tests.csproj
node tests/local-agent-lifecycle-database.cjs --session-tools
node tests/local-agent-lifecycle-database.cjs --windows-unlock
```

The C# harness links actual production transfer, path, permission, encryption,
microphone lease/capture, tools dispatch and UI orchestration sources against
the actual SIPSorcery API. WPF/WinRT contracts and native host effects are inert
adapters. This is a portable compilation/test—not a Windows executable build
or proof that a Win32 call worked. SQL runs in disposable Unix-socket PostgreSQL
with synthetic records and no remote connection. HTTP/storage failures use
isolated synthetic objects.

The development-only `/tests/session-tools-fixture.html` exercises production
React controls, file transport, screenshot and tool clients with synthetic role
login, files, audio and Agent receipts. It contains no customer sessions or
Supabase writes, and is not included as a production app route. Server role/
permission handling is tested separately against actual production handlers.
It does not certify real Supabase sign-in or Windows hardware.

## User-run Windows build and acceptance

Use an explicitly authorized, disposable Windows 10/11 machine/account. Do not
use customer sessions or real credentials in test evidence. Install the .NET 8
SDK and the existing prerequisites in the Agent README. From `imports/connectlive`
in the repository, or the extracted source archive's root (containing `agent/`
and `tools/`), **the user** runs:

```powershell
.\agent\build-developer.ps1 -SkipSign
.\agent\dist\ConnectLive.exe --session-tools-setup
```

This developer build deliberately skips installer packaging. Do not substitute
`agent\build.ps1` or an MSI/Inno script: those can bundle installers. An unsigned
source-run Agent is not a trusted unlock installation. Follow the separate,
explicit helper review/install commands in `docs/windows-unlock.md` only when
the local administrator approves that test.

Record OS build, machine/display configuration, source identity, scenario,
consent/grants, request IDs, observed result and redacted diagnostics. Never
include actual PINs, keys, tokens or credential-bearing screenshots.

| Required authorized-Windows test | Acceptance |
| --- | --- |
| Normal pairing, skip setup, legacy grant/Agent | Ordinary support works; no implicit mic/folder/unlock consent |
| Source-run and untrusted binary | Accurate separate setup blockers; PIN save never installs trusted support |
| Owner enrollment/replace/forget/revoke/key rotation | Existing encrypted envelope only; no PIN persistence/logging; correct offline limitations |
| Locked signed-in Win10/11 Hello | Existing helper verifies actual Winlogon/account/field and Windows result; no automatic replay |
| Autofill, saved passwords, browser/site passkey | Clearly on-device only; no saved-PIN release or fabricated application result |
| Cancel during preparation, wrong PIN/account/prompt, late receipts | No retry, no replay, no revived control or microphone |
| Curtain one/multiple monitors, DPI, pause/resume | Curtain excluded remotely; input-only pause preserves curtain/video; local escape works |
| Secure desktop/UAC/unknown prompt transition | Fail closed; no privilege expansion or unnoticed curtain removal |
| Local PIN setup during video/JPEG/recording | No credential-bearing pixels, clipboard, files or audio escape |
| Approved root/list paging + denied/missing/renamed files | Ordinary-user permissions and clear errors; no bulk collection |
| Traversal, junction/symlink swaps, concurrent writes | Reject escapes/changes before and throughout transfer |
| 0-byte, Unicode name, 500 MiB boundary, quota | Exact length/sequence/SHA receipt; no incomplete success or unbounded heap |
| Disconnect/cancel/missing HTTP parts/duplicate EOF | Retain recoverable parts, no duplicate success or automatic uncertain write replay |
| Screenshot video/JPEG/stale/resize/peer takeover | Current native-size PNG only; correct export permission; protected frames blocked |
| Mic consent denied, device busy/unplugged, Windows privacy denied | Distinct truthful states; no capture without owner consent |
| Mic with curtain/input pause | Visible local indicator; physical stop works; video peer/codec stays established |
| Pending Listen→Off, local stop, logout/removal/lease expiry | Actual capture disposed; reconnect starts Off |
| Bandwidth loss/jitter during large file and mic | Video remains usable; bounded audio/file queues; no audio recording/storage |
| Existing clipboard/uploads/recording/session ending | Current bindings and permissions preserved; no automatic resume |

Every native row remains **NOT RUN here** until the owner supplies actual
authorized-device evidence. Synthetic success is not release approval.
