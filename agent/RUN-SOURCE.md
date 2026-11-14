# Run the complete Agent source before packaging

This is the **Windows Agent source**; the version is recorded in the included
`SOURCE-MANIFEST.json` and `src/ConnectLiveAgent.csproj`. It includes C#,
XAML, project files, branding assets, Watch, the update helper, shared update
code, native tests and build scripts. It is not a binary-download launcher.
No Agent executable or MSI has been built for this source delivery.

## Requirements

- A Windows x64 test machine with the **.NET 8 SDK**, not just the runtime.
- Internet access for NuGet dependency restore and your ConnectLive server.
- For software VP8: the package's **x64 `vpxmd.dll`**, the process-matching
  **Microsoft Visual C++ v14 runtime** (`VCRUNTIME140.dll`), and **Windows
  Universal CRT**. The .NET SDK alone is not proof these are present.
  See [VIDEO-DEPENDENCIES.md](VIDEO-DEPENDENCIES.md) for exact official-package
  evidence, safe repair guidance and the local-only diagnostic command.
- A current, unused device-pairing code from your administrator's web console.
  No administrator password, Supabase service key or device token belongs in
  the source or launch command.

## Start from PowerShell

1. Stop any previously extracted/installed Agent. With this source runner use
   `.\run.ps1 -Disable`; older versions may still have a tray menu.
   Do not run the old EXE alongside the source build.
2. Extract the entire source ZIP into a **fresh directory**. Keep its layout:
   `agent`, `tools`, and the included shared test dependency under `admin`.
3. Open PowerShell in the extracted directory:

   ```powershell
   cd .\agent
   Unblock-File .\run.ps1
   .\run.ps1 -Pair
   ```

`run.ps1` builds the Agent, Watch and update helper **locally on your machine**
in Debug configuration, then launches the newly built Agent. It does not
call the installer script, publish a release, sign files, install a service,
or download a prebuilt Agent. Outputs go in a fresh `agent\bin\terminal-*`
folder. Do not move/delete that folder while testing its running processes.

`-Pair` explicitly opens the pairing-code screen even if this Windows user
has saved credentials from an older version. Without `-Pair`, a valid
existing pairing resumes in the background; an unpaired/stopped device still asks
for a code. Background starts never show a pairing dialog.

If your administrator uses another server:

```powershell
.\run.ps1 -Pair -ApiUrl https://your-server.example
```

If Windows policy blocks unsigned local scripts, use your organization's
approved execution-policy/signing procedure; this source does not bypass it.

## What you should see

1. **One ConnectLive pairing-code window**, in the existing blue/navy colors.
   The old status/splash window and separate authorization window are gone.
2. Enter the code and choose **Continue**.
3. Organization, session mode and allowed permissions appear **inside that
   same window**. Choose **Pair and connect** to accept that pairing.
   Invalid/expired codes remain inline errors; no permissions are added by
   the client.
4. The window closes after successful pairing. There is **no status window,
   tray icon/menu, or Stop/Disconnect control UI**. The Agent runs in the
   background under the accepted access policy.
5. The code is the only input. Permissions and session mode come from the
   administrator and are shown read-only. Closing/canceling pairing does not
   authorize access. A stopped device cannot be revived by background startup.

For a second pairing, run `.\run.ps1 -Disable`, obtain a **new** code, then run
with `-Pair` again. Codes are single-use. If the old device record consumes
the last license seat, resolve that record in the administrator console
before creating/redeeming another pairing; the client does not silently
delete existing server records.

An attended pairing can still request approval **when a technician starts a
session**. That is the chosen session policy, not the removed startup dialog.

## Local disable without another UI

In another PowerShell window in the `agent` source folder:

```powershell
.\run.ps1 -Disable
```

This invokes the running Agent's local `/disable` command and waits for it to
exit. It does not build anything or show a control panel. Alternatively run
`ConnectLive.exe /disable` from its installation/output folder, or uninstall.
Withdrawal remains local and works offline.

## Optional startup/recovery testing

Startup is not enabled implicitly by removing its checkbox. A new source
pairing defaults to manual startup. To explicitly request startup/recovery:

```powershell
.\run.ps1 -Pair -StartWithWindows
```

The single pairing screen explains that request inline before **Pair and
connect** records it. No extra checkbox or dialog is shown. Companion apps
must be present; otherwise startup stays disabled. Existing, valid pairings
keep their previously recorded startup policy.

## Agent-only command (no companions)

For a quick UI-only development run:

```powershell
dotnet run --project .\src\ConnectLiveAgent.csproj -- --pair
```

This does not build Watch or the updater; startup/recovery cannot be enabled
if those executables are absent. Prefer `run.ps1` for testing
the complete source. Neither command installs an MSI.

Without Watch running, the administrator console shows the device as
**"Agent reporting · Watch unavailable"**. That line describes the separate
startup/recovery companion, not screen capture or video; it is expected for
an Agent-only run.

## Agent log file (where to look when video does not appear)

Open the folder from a second PowerShell window, without building or pairing:

```powershell
.\run.ps1 -Logs
```

Or press **Win+R** and enter `%LOCALAPPDATA%\ConnectLive\logs`.
`%APPDATA%` is the different **Roaming** folder; the Agent uses **Local**.
Use the Windows account that actually launched the Agent.

The source runner also saves `source-run-*.log` (build/launch transcript)
and `startup-*.stderr.log` (early runtime failures). If the normal directory
is not writable, the Agent tries `%TEMP%\ConnectLive\logs`; `-Logs` checks
both locations. An empty stderr file is normal. A missing Agent log with a
present runner log means startup did not reach the Agent logger—inspect the
build/launch transcript, stderr and source version rather than assuming a
screen-capture failure.

The Agent is a windowed process, so the terminal that launched it shows
little or nothing. Every diagnostic line is written to:

```
%LOCALAPPDATA%\ConnectLive\logs\agent-YYYYMMDD.log
```

When launched from a terminal the same lines are echoed there as well. The
file can be opened or copied while the Agent is running; files older than
seven days are removed automatically. Nothing in it is a credential: it never
records pairing codes, device tokens, ICE credentials or SDP.

For a live-video session the healthy sequence, in order, is:

```
session <id> loops started (view)
DXGI: Desktop Duplication initialized \\.\DISPLAY1 1366x768 @ (0,0)
webrtc offer received (videoOnly=True, peer=none)
webrtc ice gateway: N server(s), turn=True
webrtc video format negotiated: VP8 pt=...
webrtc answer posted
webrtc pc state: connected
webrtc video source started (keyframe forced)
capture tee first-frame 1366x768 ...
webrtc video pipe: pushed=... encoded=... dropped=...   (every ~5 s)
```

The first line that is missing, or the first `[warn]` before it, locates the
fault. In particular `webrtc signal poll failing: HTTP ...`,
`webrtc ... rejected: identity check failed`, `webrtc no usable video encoder`
and `webrtc sig apply: ...` each mean the Agent never answered the viewer's
offer, which the viewer shows as "Connecting video" followed by
"Video disconnected — reconnect viewer".

## Native VP8 loading failures

Startup now checks the expected native locations, PE/process architecture and
restricted Windows loader results before a session arrives. It then tries an
actual 16×16 synthetic VP8 encode, independently of H.264 discovery. No
dependency is downloaded or installed; no permission or session policy changes.

To check locally without pairing, enrollment or a remote session, run from
`agent` on your Windows test machine:

```powershell
dotnet run --project .\src\ConnectLiveAgent.csproj -- --video-preflight
```

This builds the source **on your machine**, writes the normal Agent log and
exits. A zero exit code means diagnostics completed, not that video works.
Read [VIDEO-DEPENDENCIES.md](VIDEO-DEPENDENCIES.md) for each logged state, the
official Microsoft runtime links, single-file limitations and remaining Windows
verification steps.

Agent 1.10.7 contains the 1.10.6 curtain changes and guards cleanup after a
failed VP8 probe. Previously, disposing a partially initialized encoder could
throw another `vpxmd` loading error, aborting peer setup before the independent
hardware H.264 candidate was offered.

This does **not** supply a missing native DLL or its Windows dependencies.
VP8-only viewers still require a working VP8 runtime. H.264 requires both a
compatible viewer offer and a working hardware encoder; detecting an Intel MFT
alone does not prove encoding works. Startup diagnostics no longer claim that
the wire codec is always VP8.

The expected next evidence is a codec-negotiation message and an opened input
channel, followed by actual frames and curtain acknowledgements. A JPEG upload
alone is not that evidence. HTTP heartbeat timeouts are a separate problem;
the timeout and dead-man safeguards have not been relaxed.

If pairing already succeeds, keep the existing enrollment. Stop the old
process and run from this new source folder; repeated pairing is not a remedy
for a native codec loading error.

## Control mode and privacy curtain

### Live-session recovery and ending a visit

The asynchronous H.264 input pump now retains every `METransformNeedInput`
credit across frames instead of discarding credits received after one frame
was submitted. It does not spin for 120 milliseconds when no event is ready.
Separate output frames are not combined into one RTP access unit.

If submitted frames stop producing output for three seconds, the Agent can
rebuild the H.264 encoder twice within the same authorized peer. It does not
close input/file/clipboard channels for that in-place recovery. Persistent
encoder failure still fails explicitly and allows bounded viewer reconnection;
permissions, withdrawal and the curtain's five-second dead-man lease remain.
This is not permission to keep a terminated or revoked session running.

After the updated server explicitly reports that this exact accepted session
ended, the Agent stops remote access and opens the pairing-code window once.
The requirement survives restart and prevents Watch/updater relaunch until a
new foreground pairing is completed. Closing that window leaves access stopped.
An empty session list, missing row, heartbeat error or video-only disconnect
does **not** erase pairing or display repeated code prompts.

**Use matching Agent and server source.** The new pairing behavior needs the
updated heartbeat endpoint's `session_status` receipt; a source ZIP does not
deploy that endpoint. Startup logs now show the canonical gateway origin.
The Windows Agent and browser must use the intended same server. Changing the
server origin requires a new pairing with that server, not reuse of a grant
from another origin.

The curtain is an opaque local notice excluded from capture. Exclusion is
checked again after WPF renders, before input pause is acknowledged. If DXGI
becomes unavailable while the curtain is visible, the curtain is released
before GDI capture is allowed. This avoids sending its banner to the viewer.
Actual Windows display/capture exclusion still requires a Windows run.

Portable tests (not Windows hardware/UI execution):

```text
dotnet run --project agent/tests/session-recovery/SessionRecovery.Tests.csproj
```

From the repository, prefix that path with `imports/connectlive/`.

### Signaling and diagnostic update (1.10.9)

Use this source with the matching updated browser and gateway. No production
deployment is implied by receiving this ZIP. To test an approved preview gateway,
use `.\run.ps1 -Pair -ApiUrl https://your-approved-preview-host` and obtain the
pairing code from that **same** preview. Do not reuse credentials from another
gateway origin.

The Agent now reports an explicit, peer-scoped unsupported-codec result rather
than leaving an incompatible offer waiting. The updated browser recovers missing
realtime answers with bounded authenticated reads and keeps network-route retries
on the same codec. A temporary transport stop is no longer logged as if the
administrator explicitly ended the support session.

Heartbeat/frame logs distinguish the final request stage from the **slowest**
stage and include the gateway protocol when available. ICE logs identify the
configuration provider and protocol, but explicitly do **not** claim that a
relay was selected. Use the browser's **Connection diagnostics** to check actual
selected candidate types, traffic, decoding and presentation. Protocol `2`
identifies this diagnostic/signaling contract, not a deployed commit hash.

Before approving this candidate on Windows:

1. Run `--video-preflight` and resolve a failed VP8 runtime load only through the
   approved manual procedure in `VIDEO-DEPENDENCIES.md`. Hardware discovery alone
   does not prove encoder output.
2. On a designated test device, verify moving video for at least 20 minutes,
   including idle/resume and a brief network loss. Record actual decoded and
   presented frame progress, not just a connected badge or moving cursor.
3. Verify a separately forced relay path with actual selected-pair evidence.
4. Physically verify curtain coverage, usable technician video, local-input
   blocking, release, emergency escape, lease expiry and safe capture fallback.
5. Verify explicit **End sharing** prompts for a fresh code, while temporary
   gateway failures and **Close viewer** do not erase pairing.

Portable checks and a synthetic browser peer cannot certify these Windows
effects. This source delivery has not built an Agent EXE or MSI.

### Combined browser action

Use **Take control + curtain** in the updated browser console. The console
first requests control mode, waits for this Agent's permission acknowledgement,
then requests the curtain. Keyboard/mouse input stays paused until the Agent
confirms the local notice has rendered and local input pause is active.

Agent 1.10.6 fixes acknowledged curtain commands in both video-only and
JPEG-enabled sessions. Older JPEG-enabled Agents used a different receipt,
which could leave the browser waiting and prevent curtain renewal. The
Windows Admin's existing receipt and renewal format remains supported.

The action does not run a Windows scheduled task or script. A working JPEG
picture alone does not establish the live command channel. If that channel,
control permission or curtain support is missing, the browser explains why
the action is unavailable.

**Release control + curtain** requests view mode even if the command channel
is lost. A failed or cancelled activation does not enable remote input.
Curtain renewals stop on failure, and the Agent retains its five-second
fail-safe lease and local **Ctrl+Alt+Shift+Esc** withdrawal. Reconnection never
silently re-enables the curtain. No secure-desktop access is added.

This source update has not been compiled or exercised on Windows here.

## Automatic video recovery and sharper JPEG fallback

New sessions from the updated web console permit video and automatic JPEG
fallback. The viewer retries H.264-preferred/VP8 with direct-or-TURN ICE,
then VP8-only, then relay-only variants. It keeps a working peer instead of
interrupting it to upgrade. Retries stay within the same authorized session;
permission denial or another viewer taking ownership stops them.

For an **existing video-only** session, expand **Show actions** and select
**Enable JPEG fallback**. This explicitly asks you to confirm ending that
session and inviting a new **view-only** session. Existing authorization still
applies; attended sessions still need local acceptance. No pairing, restart,
new permission or database migration is performed.

Video-only sessions intentionally reject JPEG at the Agent, API and database.
The replacement option creates a separate `legacy`-media session instead of
silently weakening those restrictions. WebRTC continues trying, and the
**Automatic JPEG fallback enabled** notice explains which path is active.
Do not infer native video success from a visible JPEG.

This source update separates JPEG detail from the video congestion ladder:

- It encodes the original desktop pixels, up to a 3840-pixel edge and
  3840×2160 total pixels, without upscaling.
- JPEG quality is 86 during changes and 94 when static. Updates start at
  at most two per second; slow uploads reduce cadence instead of automatically
  shrinking text.
- A 1,450,000-byte JPEG cap fits the existing base64 upload limit. Exceptionally
  large images reduce quality to 80, then resolution, rather than sending
  frames the server will reject.
- Use the viewer's **1:1** mode to inspect text without fit-to-window scaling.
  A 1366×768 source remains 1366×768; genuine 4K detail needs a 4K source.
- Hardware H.264 is preferred when the hardware probe permits it. VP8 is
  probed with an actual synthetic encode, not just a format advertisement.
  A missing VP8 encoder no longer blocks hardware H.264. Encoder failures
  retire the peer for a clean negotiation; they never put VP8 into H.264 SDP.

`CONNECTLIVE_CODEC=vp8` remains an explicit compatibility override. The default
is now `auto`. The sender logs the negotiated codec separately from the preference.
The older `VP8 encoder unavailable` log does not distinguish an empty advertised
format list from a native-library failure; this version logs the actual probe.

The useful Agent log sequence is:

```text
session ... loops started (view); media=legacy; JPEG fallback=enabled
capture loop entered; JPEG fallback=on; viewing permission verified
first desktop frame captured: ...; source=DXGI (or GDI)
first JPEG uploaded successfully: ...; capture and HTTPS path working
```

- JPEG visible but no video: capture and HTTPS upload work. Inspect WebRTC
  offer/answer, encoder and ICE messages; JPEG alone cannot identify which failed.
- Capture logged but JPEG upload fails: inspect the logged HTTP status.
  401/403 concerns authorization; 409 can mean a video-only/inactive session.
- No capture-loop line: check Agent startup, heartbeat/session acceptance and
  viewing permission before blaming DXGI or VP8.
- A stationary screen remains fresh via a bounded JPEG keepalive (normally
  once per second, slower on a slow upload path).
  It runs only while capture confirms unchanged pixels and viewing is authorized.

### Upload stalls and heartbeat loss

New `HTTP op=frame` / `HTTP op=heartbeat` lines report a random request ID,
numeric status, elapsed time, deadline, safe failure category and bounded
failure/recovery counts. JPEG retains its **3-second** deadline and heartbeat
its **20-second** HTTP timeout. `outcome=deadline` is different from ordinary
session cancellation (`cancelled`) and from an HTTP 401/403/409 response.
The first failed heartbeat still stops local session channels; the third
consecutive failure also reports the dead-man safeguard.

An updated server returns matching request IDs and safe stage/timing headers.
Missing headers can mean older server code; they do not establish a network
failure. A 503 lookup/authorization result means the dependency was unavailable,
not that a device credential was proven invalid. Do not extend the deadlines,
disable the safeguard, or re-pair a device just to hide these failures.

For an explicitly authorized test, share only the `HTTP op=…` lines and matching
server `scope=agent_http` lines with the timestamp/timezone. Never share device
stores, pairing codes, tokens, request bodies or screen contents. Diagnostic
lines are rate-limited, so absent lines do not prove a request never arrived.
The full source investigation and interpretation guide is
`docs/agent-http-stalls.md` in the repository. Windows builds remain manual;
this source change is not proof that the original infrastructure fault is fixed.

The console change is part of the web source, not something the Agent ZIP
can install on the server. Use the updated preview console or publish the web
change separately. The JPEG-quality and native-codec changes require rebuilding
this Agent source on Windows. This delivery does not prove Windows video works.

## Later, after your manual verification

`build.ps1` is the **installer/release packaging script**. Do not use it for
the first terminal run. **`-SkipInno` does not skip MSI generation.**
Keep MSI bundling and production signing separate until manual testing is
complete. Signed-update acceptance also requires your publisher's public
verification key and signed test package; this archive includes no private
keys. The run script accepts an optional `-UpdatePublicKeyPath` for that
separate test.

The server must already support the documented pairing/lifecycle protocol.
This Agent source ZIP does **not** deploy the web app or database migrations.
The included server SQL and verification documents are references, not
instructions to run production migrations during this terminal test.

## Verification limits

The source/archive checks do not prove a Windows build, real pairing,
screen streaming, input, clipboard, files, recovery or MSI installation works.
Those Windows runtime checks remain necessary before a production release.
No Windows binary was compiled in the workspace for this delivery.
