# Native Admin product/source review — audit 10

## Scope and evidence limits

Read-only review of `admin/` first-party source, project/build script, documentation and spike harnesses, with targeted traces into the actual Agent receiver, gateway handlers and SQL migrations. `admin-coverage.json` records all 57 files outside generated `bin/` and `obj/` trees: 54 reviewed, one cosmetic binary asset excluded, and two generated temporary WPF projects excluded. The six generated trees are explicitly excluded by subtree. No application, build, test, workflow, live request, database migration, or Windows executable was run in this audit. No archive was modified or extracted onto the workspace. ZIP directory entries and the small README/config entries were read in place; configuration values containing credentials are deliberately not reproduced.

**Conclusion:** the source is not ready to assert native viewing/control/session-lifecycle parity. Several contracts disagree deterministically: direct control escalation/reopening versus SQL guards, flat datachannel input versus the Agent's nested parser, and text input versus the capability allowlist. Fresh invitations also race an active-only ICE endpoint without recovery. These are source findings, not claims about which SQL or executable revision is currently deployed.

The SQL file `supabase/migrations/20261021003000_recorded_device_authorization.sql:1` explicitly labels itself source-only. All statements below about database enforcement mean **when the supplied migrations are applied**. This audit did not establish deployed schema state.

## Findings

### A10-01 — High: normal Control and paused-session Reconnect contradict the authority state machine

* Connect always creates/reuses a **view** session: `admin/src/ViewModels/DevicesViewModel.cs:230`. Control then directly PATCHes mode to control before sending curtain input: `admin/src/ViewModels/LiveSessionViewModel.cs:659-676`; implementation: `admin/src/Api/ApiClient.cs:490-507`.
* The client transition trigger rejects mode changes other than to view and rejects state changes other than to paused/ended: `supabase/migrations/20261021001000_guard_client_session_transitions.sql:27-38`. The recorded-authority trigger independently rejects active-session control escalation and paused-to-active: `supabase/migrations/20261021003000_recorded_device_authorization.sql:147-155`.
* Consequently, Control from the normal view workflow fails even with a recorded control capability. Reconnect's `state=active` PATCH fails for paused/invited/closed states; already-active/view requests are a different case and need not fail. The UI reports the PostgREST error, rather than bypassing the guards.
* There is no native new-control-invitation flow. Preserve the guards; request a fresh locally authorized control invitation instead. The device-only consent handler permits only invited → active/declined and validates the grant: `src/routes/api/public/agent/session.$sessionId.consent.ts:31-65`.

### A10-02 — High: first native negotiation can permanently stop before consent arrives

* A new session starts invited (`admin/src/Api/ApiClient.cs:439-446`), and its live window immediately starts WebRTC (`admin/src/ViewModels/LiveSessionViewModel.cs:176-185,277-322`).
* `bind_admin` accepts invited state (`supabase/migrations/20261021000000_restrict_admin_binding.sql:31-41`), but ICE requires an **active**, authorized session (`src/routes/api/public/agent/ice.ts:100-115`).
* ICE 401/403 becomes an authorization exception (`admin/src/Api/ApiClient.cs:240-242`); negotiation sets `_surrendered` and returns false (`admin/src/Media/WebRtcClient.cs:149-154`). `StartAsync` then exits before starting signal polling/RTC heartbeat/watchdog (`:118-124`). It does not wait for authorization, subscribe to session activation, or retry on the eventual consent transition.
* JPEG/Realtime fallback continues independently. Reconnect only writes session/power commands; it does not start this exited WebRtcClient (`admin/src/ViewModels/LiveSessionViewModel.cs:633-648`). A connect that happens after activation can avoid this race; this is not a claim every connection fails.

### A10-03 — High: datachannel input has the wrong JSON envelope for the actual Agent

* Native DC input is flattened to `{kind,...payload}` in `admin/src/Input/InputTransport.cs:122-128,144-153`.
* The actual receiver passes that JSON directly to `InputRelay.Apply`, without wrapping it: `agent/src/WebRtcSession.cs:344-355`; `PeerInputPermission.TryApply` only gates/calls the callback (`agent/src/PeerInputPermission.cs:43-53`).
* `InputRelay.Apply` reads fields from a nested `payload` object: `agent/src/InputRelay.cs:111-128`. Thus native DC coordinates/buttons/vk/text are not read as sent. REST uses the correct `{session_id,kind,payload}` shape (`admin/src/Api/ApiClient.cs:512-520`).
* A successful SCTP send suppresses REST fallback even when the semantic payload was ignored. Align both paths on one nested envelope and validate it against the receiver, not just the sender's comments.

### A10-04 — Medium: printable text is not an authorized input kind on REST

* `admin/src/Input/KeyboardInjector.cs:33-34` sends kind `text`, but the SQL capability mapper only includes `unicode_text`: `supabase/migrations/20261021003000_recorded_device_authorization.sql:185-193`. Unknown kinds are rejected by the channel-write trigger (`:225-226`).
* The gateway polling filter also omits `text`: `src/lib/authorization.server.ts:64-70` and `src/routes/api/public/agent/session.$sessionId.inputs.ts:47-50`. The Agent does recognize both aliases (`agent/src/InputRelay.cs:127-128`), which does not repair the upstream rejection.
* Use the canonical `unicode_text` kind. DC additionally needs A10-03 fixed.

### A10-05 — High: Sign out leaves live remote peers and session windows running

* `admin/src/Views/MainWindow.xaml.cs:21-25` clears authentication and closes only the device-list window. `admin/src/Api/ApiClient.cs:216-220` stops renewal and clears the local store; it does not revoke the server refresh session or close live windows.
* Live peers are closed/end-session is sent only through the live window's Closed handler (`admin/src/Views/LiveSessionWindow.xaml.cs:71-79`, `admin/src/ViewModels/LiveSessionViewModel.cs:484-525`). No sign-out subscription invokes this cleanup.
* Existing SCTP/media channels do not acquire JWT headers per packet. Clearing `AuthStore` is therefore not a local disconnect boundary. A later account login replaces the same global Api/Auth used by surviving old windows. Coordinate teardown, safety release and bounded end attempts before switching identities; separately revoke refresh tokens if logout is intended to invalidate the remote auth session.

### A10-06 — High: static transports and unscoped file events cross concurrent live windows

* Every Connect opens another independent window (`admin/src/ViewModels/DevicesViewModel.cs:225-242`), with no existing-session/window check.
* Input, files and clipboard each have one process-global channel (`admin/src/Input/InputTransport.cs:32-44`, `admin/src/Media/FileTransport.cs:31-46`, `admin/src/Media/ClipboardTransport.cs:25-32`). Clipboard send accepts no session identifier (`ClipboardTransport.cs:109-125`). Clicking Send clipboard in one window therefore targets the last attached clipboard channel, not necessarily that window's session.
* All live VMs subscribe to the same `FileTransport.FileReceived` event (`admin/src/ViewModels/LiveSessionViewModel.cs:811-818`). `ReceivedFile` has no session identifier (`admin/src/Media/FileTransport.cs:266-278`); each listener uploads the received bytes into **its own** SessionId (`LiveSessionViewModel.cs:887-900,1152-1159`). Where both sessions authorize files, a single received file is persisted into both.
* Closing any peer unconditionally detaches all three global transports (`admin/src/Media/WebRtcClient.cs:706-714`), including channels owned by another still-open window. Use per-session transport instances and session-scoped event ownership. Input's session-id check prevents the same direct misrouting as clipboard, but does not prevent this shared teardown.

### A10-07 — High: closing a superseded window ends the replacement owner's session

* Takeover cancellation sets `TakenOver` and cancels pumps but leaves the window open (`admin/src/ViewModels/LiveSessionViewModel.cs:131-140`).
* Closing it still calls Stop, sends safety inputs and unconditionally PATCHes that same session to ended (`:489-525`; `admin/src/Api/ApiClient.cs:463-471`). The PATCH has no `admin_client_id` predicate.
* The supported same-technician/two-machine case still has valid owner RLS (`supabase/migrations/20260722192609_e76e69d7-8f4b-4c64-b780-e0812f5af976.sql:21-24`); ending is allowed by both guards. Thus the old window can end the newly bound machine's shared row.
* Separately, reuse PATCHes `technician_id` (`ApiClient.cs:418-423`), but changing technician is now forbidden even to service-role/super-admin writes by `20261021003000_recorded_device_authorization.sql:138-145`. Same-user takeover and cross-user transfer must not be treated as interchangeable.
* Split local detach from authoritative End, and require current binding ownership for End. Do not weaken the immutable-identity trigger.

### A10-08 — Medium: claimed ordered/reliable signaling can silently drop its final failure

* `admin/src/Api/ApiClient.cs:573-599` retries six times, but exhaustion returns normally; cancellation during retry delay also returns normally. `admin/src/Media/WebRtcClient.cs:259-264` then logs offer-post success and continues.
* Every HTTP 409 is treated as success, without checking the PostgreSQL error/constraint (`ApiClient.cs:561-564`). This is broader than the intended duplicate-attempt unique constraint.
* The comment that candidates cannot overtake the offer/answer is not guaranteed by construction: `setLocalDescription` runs after ICE callbacks have been wired and before the offer is queued (`WebRtcClient.cs:201,254-260,269-282`). A single semaphore serializes arrival at the gate, not SDP-before-candidate dependency.
* Return/throw the exhausted error and explicitly stage candidates behind a successfully published offer.

### A10-09 — Medium: concurrent refresh paths bypass the advertised serialization

* `EnsureFreshTokenAsync` uses `_refreshGate` (`admin/src/Api/ApiClient.cs:151-162`), but the REST 401 retry calls `RefreshSessionAsync` directly (`:322-333`). Startup silent refresh also does (`admin/src/App.xaml.cs:130-136`). Frame/cursor/signal polls can therefore rotate the same refresh session concurrently with background renewal.
* On unsuccessful refresh the 401 response was already disposed and is returned to callers (`ApiClient.cs:325-336`); later error-body reading cannot reliably obtain the original response.
* Use one serialized rotation path for every caller and retain a usable failure response. Gateway requests have no 401-refresh retry at all (see matrix).

### A10-10 — High: Admin file receiver has no streaming admission cap or completion validation

* `admin/src/Media/FileTransport.cs:180-200` accepts arbitrary declared size and finalizes on any `file_end`; `:213-217` appends all chunks without checking total against declared size or MaxFileBytes. `:220-224` checks only the allocation after all parts are buffered.
* The VM's 500 MiB check runs **after** Combine has allocated/copied the entire file (`admin/src/ViewModels/LiveSessionViewModel.cs:887-898`). A peer can exhaust the technician process before this check. The Agent-side receiver already drops over-cap streams mid-flight (`agent/src/FileTransfer.cs:187-197`); Admin has no equivalent.
* No declared-size equality or peer-supplied digest is checked. SHA256 here describes the bytes actually received, not proof that the complete intended file arrived.
* `OnMessage` also classifies frames by short length/leading `{`, not SCTP message type (`FileTransport.cs:85,172-211`), so a short binary chunk beginning with `{` is parsed/discarded as control. Bound early, track cumulative bytes, distinguish text/binary, and reject incomplete completion.

### A10-11 — Medium: FlushNow does not impose move-before-click ordering

* `admin/src/Input/InputCoalescer.cs:79,92-97` merely schedules mouse moves on `Task.Run`. The UI calls FlushNow and immediately awaits button/wheel/key sends (`admin/src/Views/LiveSessionWindow.xaml.cs:376-417,479-481`).
* Button handling reads only button, not the accompanying x/y (`agent/src/InputRelay.cs:120-123`). The click can therefore be dispatched before the scheduled positioning move. Ordered SCTP preserves actual send order, not order of task creation. REST writes also have no per-session input queue.
* Serialize/await moves and discrete inputs in one transport queue; do not count the current fire-and-forget flush as an ordering guarantee.

### A10-12 — Medium: release lookup exists, but no native updater or banner calls it

* `admin/src/Api/ApiClient.cs:284-309` implements release lookup/DTO parsing. No Admin caller invokes GetReleaseAsync; `admin/src/Views/MainWindow.xaml:22-27` exposes only Orders, Refresh and Sign out.
* No native download/hash-validation/version comparison/install/mandatory-version enforcement path exists. Parsed `sha256` and `Mandatory` are unused. The claim that Admin shows an update banner (`src/routes/api/public/agent/release.ts:13`) is ahead of this client.
* This is missing functionality, not an observed arbitrary-update execution vulnerability.

### A10-13 — Medium: ordinary build output carries an intentionally unusable config

* `admin/src/admin.config.json:1-5` has empty Supabase origin/key. `admin/build.ps1:50-52` copies it straight into dist; startup validates the origin/key and fails (`admin/src/Api/AppConfig.cs:39-44`, `admin/src/App.xaml.cs:84-103`).
* `admin/INSTALL.md:38` says this file overrides built-in defaults, but there are no working defaults; an existing adjacent template also prevents the AppData fallback (`AppConfig.cs:18-25`).
* The separate ZIP packaging script supplies generated deployment config (`scripts/package-windows-desktop.py:18-34`). The reviewed ZIP's config has the three expected fields and a nonempty publishable-class key; the source template and ZIP config are **not byte-identical**. No key value is included here.
* Document/provide a required deployment-config step for build.ps1, preferably fail packaging on an empty template rather than fail after launch.

### A10-14 — Medium: renegotiation cannot switch the decoder back from H.264 to VP8

* H.264 and VP8 are both offered (`admin/src/Media/WebRtcClient.cs:176-184`), matching Agent payload IDs and H.264 parameters (`agent/src/WebRtcSession.cs:250-260`).
* The format callback only sets H.264 state, never clears it for VP8 (`WebRtcClient.cs:189-199`). Re-negotiation reuses the same pipeline and `_wireCodecIsH264`; `admin/src/Media/VideoPipeline.cs:258-275` disposes the VP8 decoder and only supports the one-way switch.
* If an ICE restart/new answer selects VP8 after H.264, incoming VP8 remains routed to H264Decoder and recording remains marked H.264. This is a conditional state-machine defect demonstrated by the source, not an observed Windows decode failure.
* Recording is explicitly VP8-only (`WebRtcClient.cs:412-420`), but the UI reports every null StartRecording as “check disk permissions” (`admin/src/ViewModels/LiveSessionViewModel.cs:975-978`), including this intentional codec rejection. Expose the actual supported codec/state to the command.

### A10-15 — Medium: Realtime drops a valid configured HTTPS port

* Origin validation explicitly accepts HTTPS host[:port] (`agent/src/NativeGatewayPolicy.cs:11-20`).
* `admin/src/Media/RealtimeChannel.cs:115-117` constructs WSS using `Uri.Host`, discarding `Uri.Port`. A valid custom-port Supabase origin is used correctly for REST but Realtime connects to the default TLS port. Preserve the URI authority. No custom-port live request was made.

### A10-16 — Low: shipped-source documentation and native status claims overstate current behavior

* `admin/INSTALL.md:60-61` says Admin signals use the agent signal gateway; actual Admin uses PostgREST. `:68-72` says exactly one VP8 format; actual source offers H.264+VP8. `:77-81` calls D3DImageHost a scaffold; actual H264Decoder and presenter implementations exist.
* `admin/Native-Video-Engine-B.md:9,16,42` describes STUN-only and an older encoder version; current code fetches TURN and csproj pins Encoders 10.0.4 (`admin/src/ConnectLiveAdmin.csproj:31-33`).
* README says top-bar links open payments/team/notifications/hub (`admin/README.md:11-13`), while only Orders is wired (`admin/src/Views/MainWindow.xaml:23-26`).
* The media UI labels are not measurement guarantees: “LIVE” is unconditional (`admin/src/Views/LiveSessionWindow.xaml:110-112`); `VideoPipeline.IsPresenting` measures recent **decode**, not actual present success (`admin/src/Media/VideoPipeline.cs:100-102,412-416`); wire_path is inferred from any exchanged candidate, not the nominated pair (`admin/src/Media/WebRtcClient.cs:301-315`). Keep diagnostics explicitly qualified.

## Authority and transport observations

* Login's response keys and lockout keys match native DTO attributes (`Api/Models.cs:7-19`) and actual gateway handler (`src/routes/api/public/auth/login.ts:49-57,92-106,124-129`). Login itself is not a staff-role gate; a valid account can receive a session. Device/session/power operations depend on server/RLS authority, not native labels or decoded JWT claims.
* Local `sub`/`exp` decoding is not signature validation and is only local identity/expiry bookkeeping (`Api/ApiClient.cs:874-899`). Server Auth validates bearer tokens. AuthStore uses DPAPI CurrentUser (`Api/AuthStore.cs:37-43,54-59`); ClientId is plaintext routing metadata, not a credential (`Api/ClientIdStore.cs:9-17,25-40`).
* Device select permits staff, including viewer through the staff policy (`supabase/migrations/20260721132626_7514b933-b764-43e0-99f0-311ecfecf9c1.sql:11-15`). Creating own sessions requires technician/admin (or super-admin policy); delete-device allows admin/super-admin and separately a customer-own-device policy (`20260727134318_2fb4bfc6-d19e-4fa7-9e9a-6db474600711.sql:1`, `20260805152950_c51b5231-bccf-4874-854c-2b4420af3b89.sql:48-67`). Native does not hide commands by role.
* `bind_admin` is a TABLE-returning RPC. Native accepts the normal PostgREST array and a single object (`Api/ApiClient.cs:615-621`); payload argument names match SQL exactly. It enforces owner/super-admin, allowed states, client-id syntax, row locking and a 45s lease; it is **not** a recorded-view-grant or control grant. Its UPDATE is additionally subject to the recorded-authority trigger. Native runs two 15s binding loops (fallback and RTC). They only treat `superseded` as terminal; `not_active`, `forbidden`, `rpc_error` on later heartbeats do not stop the UI.
* Recorded capability enforcement is server-side: active state, consent, grant binding/current owner, unreversed withdrawal, view/control mode and capability booleans (`20261021003000_recorded_device_authorization.sql:98-119`). Restrictive frame/cursor/signal/input/file/storage policies AND with historical permissive policies (`:259-290`). This is why an empty PostgREST array can mean “not visible”, not “no new data”.
* File metadata and byte URLs now match: prepare returns `signedUrl` as a compatibility field holding an identifier-only relative proxy URL, not bearer access (`src/routes/api/public/admin/session.$sessionId.files.ts:103-106`). Native sends JWT on each proxy request, validates same scheme/host/port/path/query names, rejects redirects, downloads encrypted ZIP locally, then shell-opens the local path (`Api/ApiClient.cs:767-855`). Backend checks user + session files grant and repeats authority checks while processing (`src/lib/session-file-proxy.server.ts:68-152`). Native has no direct Storage signed-URL request.
* File list polling ignores returned `Ok=false` without a status message (`ViewModels/LiveSessionViewModel.cs:839-845`). Upload paths use CancellationToken.None from UI/inbound callbacks, can continue after session window closure and rely on backend revalidation to deny persistence. A DC send has no receipt acknowledgment, and the VM always persists a second copy to storage. HTTP persistence alone is not evidence the Agent saved the file.
* Archive password verification is a real auth password check, but it is **any** successfully verified account email/password, not a check that the account owns the session device (`src/routes/api/public/admin/session.$sessionId.files.ts:165-185`, `src/lib/session-files.server.ts:108-115`). It is used as ZIP encryption material, cached wrapped for two hours; it must not be represented as an additional session-ownership factor.
* Recording permission is fail-closed: GET authorization requires JWT owner/super-admin and active recorded permission; native checks allowed=true, UUID authorizationId and recording=true, with 3s request budget, a five-second local monotonic lease, two-second renew interval and per-frame check (`Api/ApiClient.cs:54-76`, `ViewModels/LiveSessionViewModel.cs:932-1015`, `Media/WebRtcClient.cs:377-385`). This does not encrypt local IVF recordings or implement retention/deletion; IVF is written under the user's Videos folder (`WebRtcClient.cs:425-431`, `Media/IvfWriter.cs:56-74`). No Windows recording/playback/withdrawal timing was measured.
* Gateway and REST HttpClient redirects are disabled (`Api/ApiClient.cs:46-47`, shared `NativeGatewayPolicy.cs:23-25`); both configured origins require explicit HTTPS origins. File byte clients separately disable redirects. The sole shell browser link is configured-origin `/order`, with no JWT in the URL. There is no native token handoff to a browser.
* Video is recvonly, no audio track. Decode uses a three-frame drop-oldest queue; presentation uses a two-frame pacing buffer with D3D/bitmap fallback and separate JPEG polling. The source includes device-loss handling and cleanup, but manual COM declarations, driver recovery, color accuracy, perf and disposal races require Windows validation. Source inspection is not approval of those runtime properties.

## Complete native HTTP/PostgREST/RPC matrix

Paths in this table are relative to configured **G** = gateway BaseUrl or **S** = SupabaseUrl. `A:n` expands to the exact source file `admin/src/Api/ApiClient.cs:n`.

**Shared transport policy:** every A request uses no automatic redirects. Default HttpClient timeout is **20 seconds per SendAsync**, plus caller cancellation (`A:46-47`), not a whole-operation deadline. **R** below means PostgREST `apikey` + current technician `Authorization: Bearer`; the common wrapper retries once after **401 only**, directly refreshing and cloning the original request (`A:313-360`). It does not retry 403, and a compound operation can consume multiple 20s sends. **J** means gateway bearer JWT only, no automatic refresh/retry. JSON names are case-sensitive DTO attributes; table reads are arrays, not `{items:...}` envelopes. `sid`, `did`, `cid` below denote session-row UUID, device-row UUID and persistent Admin ClientId.

| Native entry / implementation | Method and route | Payload / query and authentication | Response consumed / compatibility | Retry, timeout and caller lifecycle |
|---|---|---|---|---|
| LoginAsync, A:167-189 | POST G `/api/public/auth/login` | `{identifier,password}`, no bearer | `{session:{access_token,refresh_token}}` or `{error,attemptsLeft,lockedForSeconds}`; saves only HTTP success+session | No retry, 20s; SignIn uses None; login gateway does 3-failure/60-minute lockout |
| RefreshSessionAsync, A:192-213 | POST S `/auth/v1/token?grant_type=refresh_token` | `apikey`, `{refresh_token}`, no access bearer | success JSON `access_token,refresh_token`; rotates DPAPI store and raises TokenChanged; non-2xx false | No internal retry; startup 15s CTS; renewal wakes 15–300s around exp−60s, failure 20/30s; REST also invokes directly |
| CanRecordSessionAsync, A:54-76 | GET G `/api/public/admin/session/{sid}/authorization` | J, no body | requires boolean allowed, UUID authorizationId, capabilities.recording; other responses false | No retry; 3s linked deadline; on Record and every 2s while recording, local lease 5s |
| GetIceServersAsync, A:231-268 | GET G `/api/public/agent/ice?sessionId={sid}` | J, encoded sid | `iceServers[]`, urls string/array, optional username/credential; compatible; ignores ttlSeconds/turn envelope fields | No retry; 12s negotiation CTS; 401/403 terminal; other HTTP/network failures → STUN fallback; see A10-02 |
| GetReleaseAsync, A:284-309 | GET G `/api/public/agent/release?product={product}&channel={channel}` | J if present; current intended admin/stable parameters | 204/null or `{product,channel,version,download_url,sha256,notes,mandatory}`; ignores min_supported_version | 20s, catches all to null; **no native caller**, no banner/updater lifecycle |
| ListDevicesAsync, A:363-371 | GET S `/rest/v1/devices` | R; select id,device_id,display_name,hostname,os,last_seen_at,status,is_session_active,metadata; order last_seen_at.desc | `DeviceRow[]` | R; grid immediate poll then 5s healthy, failure ladder 10/20/30s; request itself uses None even when poll loop is canceled |
| GetDeviceAsync, A:378-386 | GET S `/rest/v1/devices` | R; same select, id=eq.did, limit=1 | first DeviceRow or null | R; monitor poll every 10s; linked session CTS, errors swallowed until next tick |
| DeleteDeviceAsync, A:389-393 | DELETE S `/rest/v1/devices?id=eq.{did}` | R; no body | only HTTP success checked; no affected-row confirmation | R; manual confirmation, None; zero rows under RLS can still look successful |
| CreateSessionAsync lookup, A:404-429 | GET S `/rest/v1/sessions` | R; select=*, device_id=eq.did, state=in.(invited,consented,active,paused), order created_at.desc, limit=1 | SessionRow[] first live row | R; Connect None; no waiting for state/consent |
| CreateSessionAsync reuse, A:415-429 | PATCH S `/rest/v1/sessions?id=eq.{sid}&select=*` | R; Prefer return=representation; `{mode,admin_client_id:cid,technician_id:userId}` | SessionRow[]; **empty representation falls back to prior lookup row**, not failure | R; same compound Connect; immutable technician/binding-grant checks may reject |
| CreateSessionAsync new, A:433-453 | POST S `/rest/v1/sessions?select=*` | R; Prefer return=representation; `{device_id:did,mode,state:"invited",technician_id:userId,admin_client_id:cid}` | SessionRow[]; empty is explicit error | R; Connect then best-effort wake_agent then new window |
| EndSessionAsync, A:463-487 | PATCH S `/rest/v1/sessions?id=eq.{sid}` | R; `{state:"ended",ended_at:UTC}` | any 2xx treated as success, no representation/affected count | Up to 3 attempts with 400/800ms delays, each R may retry 401; None from Stop; final failure only log, no UI completion |
| SetSessionModeAsync, A:490-495 | PATCH S `/rest/v1/sessions?id=eq.{sid}` | R; `{mode}` | any 2xx, otherwise SupabaseCallException | R, None, ToggleControl; control escalation incompatible with guards |
| ResumeSessionAsync, A:502-507 | PATCH S `/rest/v1/sessions?id=eq.{sid}` | R; `{state:"active",mode:"view",updated_at:UTC}` | any 2xx, otherwise exception | R, None, Reconnect/network-change callback; no peer reconstruction |
| PushInputAsync, A:512-522 | POST S `/rest/v1/session_inputs` | R; `{session_id:sid,kind,payload}` | any 2xx; throws otherwise | R; event calls default/None; curtain 1s linked CTS; safety release/curtain_off always REST; no common input FIFO |
| PushTelemetryAsync, A:532-537 | POST S `/rest/v1/session_telemetry` | R; row supplied by WebRtcClient.cs:577-605: session_id,admin_client_id,fps,bitrate_kbps,latency_ms,queue_depth,frames_decoded/dropped/presented,source_width/height,render_path,input_path,wire_path,ice_restarts,peer_state | any 2xx; columns match telemetry creation plus bitrate addition | R; first 15s then every 60s with session CTS; failures logged, not fatal |
| PushSignalAsync / Reliable, A:545-599 | POST S `/rest/v1/session_signals` | R; `{session_id:sid,from_side:"admin",kind,payload,admin_client_id:cid,attempt_id?}`; kinds offer/ice/bye from current callers | any 2xx, **any 409 accepted** | Per-session gate, six attempts 250ms exponential capped 4s; hard 400/401/403/404/413 thrown; exhaustion silent; RTC CTS; Close uses nominal 2s bye CTS but fire-and-forgets before disposing CTS |
| BindAdminAsync, A:605-621 | POST S `/rest/v1/rpc/bind_admin` | R; `{_session_id:sid,_client_id:cid}` | PostgREST TABLE array `[ {bound,admin_client_id,reason} ]`; native also accepts object; non-2xx → `(false,"rpc_error",null)` | R; before RTC negotiation plus immediate fallback bind, both then every 15s with session CTS; false reasons mostly nonterminal |
| PollAgentSignalsAsync, A:628-639 | GET S `/rest/v1/session_signals` | R; select=id,from_side,kind,payload,admin_client_id; session_id=eq.sid, from_side=eq.agent, id=gt.since; or admin_client_id=cid/null; order id.asc, limit=100 | SessionSignal[]; computes max client-side; answer.sdp, ice.candidate/sdpMid/sdpMLineIndex, terminated, bye | R; 500ms healthy/2s after errors, linked RTC CTS; cursor advanced before application; no negotiation-generation filter, old answer/ICE possible on reuse/restart |
| GetLatestFrameAsync, A:652-668 | GET S `/rest/v1/session_frames` | R; select=frame,updated_at; session_id=eq.sid, optional updated_at=gt.since, order desc, limit=1 | array; base64 `frame` to bytes, updated_at string; empty/null/malformed base64 → no sample | R; fallback remains on under native/Realtime; 120ms, idle 600ms after >10 empty, 2s error; session CTS |
| PollSessionCursorAsync, A:676-696 | GET S `/rest/v1/session_cursors` | R; select=x,y,frame_w,frame_h,kind,visible,updated_at; same optional time filter/order/limit | first array row → typed sample or null | R; 100ms, idle 500ms, error 2s; session CTS |
| EnqueuePowerCommandAsync (both overloads), A:703-727 | POST S `/rest/v1/power_commands` | R; Prefer return=minimal; `{device_id:did,kind,payload:{...},state:"queued",expires_at:now+5m,requested_by:userId,relay_device_id?}`; restart normalized to reboot | any 2xx; does **not** poll dispatch/delivery result | R; None from UI; Connect wake_agent `{session_id}`, Wake `{mac}`+relay, control menu lock/reboot/shutdown, restart_stream/restart_agent, switch_monitor `{device_name,index}` |
| ListSessionFilesAsync, A:746-753 | GET G `/api/public/admin/session/{sid}/files` | J, Accept JSON, x-action:list | `{ok,files:[id,name,size_bytes,mime,sha256,direction,transport,created_at],bytesUsed,hasPassword}`; failure Error DTO | No retry; 20s; every 5s session-linked file loop plus manual refresh; false result silently ignored by VM |
| PrepareSessionUploadAsync, A:756-764 | POST same G files | J, x-action:prepare; `{name,size}` | `{ok,path,signedUrl}`; token DTO field unused; URL is relative authenticated proxy | No retry; 20s; upload operations usually None; size/quota checks server-side |
| UploadToSignedUrlAsync, A:767-778 | PUT G `/api/public/admin/session/{sid}/files/bytes?path=...` | JWT + Content-Type mime; stream bytes, validated same-origin proxy only | any 2xx; status exception otherwise; no signed storage bearer URL | No retry/refresh; dedicated HttpClient 10m; None from send/inbound upload; server byte cap/revalidation |
| RegisterSessionFileAsync, A:827-836 | POST G files | J, x-action:register; `{path,name,size,mime,sha256,direction,transport}` | checks HTTP success only; actual route returns `{ok:true,id}` on success, 400 otherwise | No retry; 20s; after byte upload; failed registrations can leave orphan bytes |
| RequestZipAsync, A:839-855 | POST G files | J, x-action:package; `{fileIds:[...]}` | `{ok,count,url}`; compatible DTO; server requires files grant and cached password | No retry; 20s metadata request; then separate authenticated download; manual None |
| DownloadFileProxyAsync, A:802-824 | GET G `/api/public/admin/session/{sid}/files/bytes?fileIds=...` | JWT; same-origin/path/query validation; proxy also supports fileId but no native UI single-file caller | encrypted ZIP stream copied to unique temp `.zip`; returns local path; deletes only on failure | No retry/refresh; dedicated 10m response-headers request; body CopyTo uses caller CTS, no explicit total body deadline with None; successful temp files have no cleanup policy |
| SubmitSessionPasswordAsync, A:858-863 | POST G files | J, x-action:password; `{email,password}` | boolean HTTP success, discards response detail | No retry; 20s; manual unlock, None; VM clears bound string on success but PasswordBox is not cleared in code |
| DeleteSessionFileAsync, A:866-871 | DELETE G files | J, x-action:delete; `{fileId}` | boolean HTTP success | No retry; 20s; manual delete, None; subsequent list refresh on success |
| Logout, A:216-220 | **No HTTP request** | local DPAPI store clear | no remote auth revocation | Stops renewal only, not live peers; see A10-05 |

### Non-HTTP native channels

| Channel | Wire contract, auth and response | Retry/deadline/lifecycle |
|---|---|---|
| Supabase Realtime | WSS `/realtime/v1/websocket?apikey=...&vsn=1.0.0`; joins session_frames/session_cursors with `config.postgres_changes` session_id filter and current access_token; handles `phx_reply`, `phx_error`, `phx_close`, `postgres_changes.payload.data.record`; pushes per-topic access_token on renewal. `admin/src/Media/RealtimeChannel.cs:115-117,258-285,356-410` | Outer reconnect 1–15s exponential; join ack 10s; Phoenix heartbeat every 25s; socket keepalive 20s. Connect/receive have session cancellation but no independent handshake or read deadline. Dispose cancels, attempts CloseAsync with None. Concurrent SendJson calls have no send semaphore. HTTP fallback stays on. |
| Input SCTP | ordered/reliable channel `input`, created before offer; established DTLS peer, no per-packet JWT. Native flat `{kind,...payload}` is incompatible with nested receiver; REST fallback on not-open/session mismatch/send exception, not semantic rejection. | No ack or per-event deadline; static channel; demoted until Attach after send error; safety commands always REST. |
| Files SCTP | ordered/reliable `files`; file_begin/file_end/file_error JSON strings and 64KiB binary chunks; from Agent and Admin. No receipt ack, no transfer ID; authenticated peer and Agent files capability check. | 4MiB bufferedAmount backpressure with 20ms wait, caller cancellation only; UI passes None; static incoming stream/events. HTTP storage persistence always follows outbound attempt. A10-06/10 apply. |
| Clipboard SCTP | ordered/reliable `clip`; `{type:"clip",text}`; 256K **characters**, not a UTF-8 byte ceiling; receive sets local STA clipboard and deduplicates last text. Agent independently checks clipboard permission. | No ack/timeout/fallback; global channel, no SessionId; detach resets state but does not unsubscribe old callbacks. |
| Video RTP/RTCP | recvonly H.264 PT102/90000, packetization-mode=1/profile-level-id=42e01f; VP8 PT96/90000. Agent answers; PLI requests keyframes, no audio. | 750ms PLI minimum, escalation after six requests; restart spacing 15s, cap four, reset count after >2min; first connect watchdog 12s; authorization denial exits negotiation. Native decode retirement hands display to JPEG but is not codec renegotiation. |

### Actual server/schema anchors for the matrix

* Gateway auth: `src/routes/api/public/auth/login.ts:23-133`.
* ICE: `src/routes/api/public/agent/ice.ts:88-118,265-301` (4s auth race, provider budget 5s, authorized principal mint admission 10/min/process; returned relay TTL 12h). Release: `src/routes/api/public/agent/release.ts:32-81` (valid authenticated account; its “technician” helper does not check staff roles).
* Native recording authorization: `src/routes/api/public/admin/session.$sessionId.authorization.ts:10-38`; delegated server RPCs `session_authorized` and `device_authorization` are **not** additional native RPC calls.
* Files metadata/bytes: `src/routes/api/public/admin/session.$sessionId.files.ts:53-220`, `src/routes/api/public/admin/session.$sessionId.files.bytes.ts:5-16`; helper ownership/size/path/byte/ZIP checks `src/lib/session-file-proxy.server.ts:31-152`.
* Device/session schema + native RLS scope: `supabase/migrations/20260721082936_05993b89-bf3e-4b97-9442-d9dfb391084e.sql:41-90`, `20260721132626_7514b933-b764-43e0-99f0-311ecfecf9c1.sql:1-15`, `20260722192609_e76e69d7-8f4b-4c64-b780-e0812f5af976.sql:2-28`.
* Owner channel policies: `supabase/migrations/20260728122915_a2afac77-db11-4898-8c11-0acb782568ff.sql:37-102`; current restrictive authorization policies/guards: `20261021003000_recorded_device_authorization.sql:98-183,204-290`.
* Binding TABLE response/current permissions: `supabase/migrations/20261021000000_restrict_admin_binding.sql:3-49`. Signal retry key: `20260728233852_873881e0-41c2-4621-aa4b-9b335e033b13.sql:5-11` (attempt_id unique index). Telemetry columns/RLS: `20260803094656_764ff773-a248-42c7-ae34-f6b820c71c98.sql:1-34`, `20260805065845_8146d9ca-574d-4b7f-9102-a54d90d5cafc.sql:1`.
* Power insert's requested_by/staff check: `supabase/migrations/20260727223653_87da6092-5d47-4dc3-bdeb-a1ab968f0170.sql:39-49`; kind enum subsequently includes switch_monitor/restart_app: `20261005092925_0bc8bce0-0fb5-4ebe-a9a7-69f1576d3317.sql:5-6`.

### Missing, unused and deliberately absent native paths

* `GetReleaseAsync` is unused; no updater, minimum-supported-version handling or native version banner.
* `ApiClient.Logout` has no `/auth/v1/logout` request. There is no native authority-state poll/subscription, capability-aware Control invitation, native grant record/revoke call, or reconstruction of an exited RTC startup on activation.
* The only native direct SQL RPC is `bind_admin`. Native does not invoke `has_role`, `session_authorized`, `device_authorization`, consent/reconnect device routes, pairing-code redemption, or createServerFn web wrappers. Those are server/delegate/device surfaces, not missing bearer shortcuts to add.
* No native `/api/public/agent/session/{id}/signal` caller despite INSTALL documentation. Admin signals are PostgREST arrays; Agent uses its own gateway envelope. No native storage upload/sign/mint API calls; `PrepareUploadResponse.Token` is obsolete/unused.
* `SimpleResult` DTO is unused. `FileTransport._inboundQueue` and MaxSessionBytes are unused for admission. `ClipboardReceived` has no Admin subscriber; inbound handling still sets clipboard itself. ToggleFilesPanel command has no XAML caller (the toggle binds FilesPanelOpen directly).
* Power helpers permit logoff and relay metadata; current toolbar has lock/reboot/shutdown, not logoff/restart_app. No power command completion polling exists. No native customer account/payment/team/inbox/hub screens or browser links beyond Orders.
* Spikes are not referenced by the main csproj and are not a shipping command. The retired VP8 capture producer is absent by design; no current capture input or recorded spike result was supplied/validated by this audit.

## ZIP, build and source-to-binary traceability

Target: `generated-artifacts/windows-desktop/ConnectLive-Admin-Windows-x64.zip`.

Read-only directory listing showed exactly four entries below `ConnectLive-Admin-Windows-x64/`:

| Entry | Review performed |
|---|---|
| `ConnectLiveAdmin.exe` (201,120,071 uncompressed bytes in ZIP directory) | Directory metadata only. Not launched, decompiled, hashed, signature-checked or extracted in this audit. |
| `README.txt` | Read in place; explicitly calls this unsigned, portable, non-installer, Linux-built and Windows-runtime-unverified. |
| `admin.config.json` | Parsed in place and reported only field names/nonempty public-key classification; no credential value output. |
| `SHA256SUMS.txt` | Entry presence only; hash/CRC/content validation reserved to owning agent. |

The external manifest `generated-artifacts/windows-desktop/release-manifest.json:10-16` declares win-x64, signed=false and windowsRuntimeVerified=false. These are producer declarations, not independent signature/runtime verification by this audit.

**Portable ZIP, not installer:** no MSI/setup, service installer, startup task, native updater or uninstall component is among these entries. README tells the operator to extract all files and launch the exe. Do not equate “self-contained” with installed, signed, trusted, or Windows-tested.

**Two distinct production paths:** `admin/build.ps1:27-68` restores/publishes the explicit main csproj, stages config/readme/icon, optionally signs and creates `dist/ConnectLiveAdmin.zip`. Signing can deliberately remain unsigned (`:20-25,75-80`; `tools/CodeSign.ps1:97-120`). The reviewed generated archive instead follows `scripts/package-windows-desktop.py:84-117`: alternate name/folder, README, configured public config, sums and manifest; its signing flag is false. This audit read that script but did not execute its network validation or integrity checks.

**Traceability limit:** the main source project declares Version 1.7.2, self-contained win-x64 and single-file output and links the shared Agent NativeGatewayPolicy (`admin/src/ConnectLiveAdmin.csproj:5-33`). The generated manifest contains no commit ID, source-file hashes, dependency lock/build attestation or compiler identity. Neither it nor the ZIP proves that its executable contains these exact reviewed source bytes. The differing template/deployment config is known; executable source equivalence is **unestablished**, not asserted false. Existing bin/obj outputs and temporary WPF project files do not constitute a reproducible provenance chain.

All functional findings above are located in exact source; apply them to the ZIP executable only after the owning agent establishes binary provenance. The next validation remains an authorized Windows session covering local consent, invited→active viewing, fresh control authorization, input-envelope correctness, dual-window/session isolation, logout, same-user takeover plus stale-window close, reconnect, TURN-only network, codec change, file limits and recording withdrawal. No success on those runtime gates is claimed here.
