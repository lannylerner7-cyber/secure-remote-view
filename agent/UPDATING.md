# Authorized startup and signed updates

## Status and scope

Source implementation and Linux-hosted cross-build/model checks are available.
**Windows installation, job-object behavior, crash recovery and rollback have
not been executed on an actual Windows device. Do not claim fleet reliability.**
Native Admin is retained pending measured browser parity and explicit approval.

Startup/crash recovery is a separate, unchecked local choice, bound to the
recorded grant, device and server. It is not implicitly enabled by Allow all
remote permissions. Installed applications use a visible tray, HKCU Run and a
visible, least-privilege interactive-user Watch task. Silent installation copies
files; it does not enroll a user or enable startup. Local withdrawal wins even
while a network request or update is in progress.

Watch and update recovery require a fresh matching server grant before
relaunching. A dormant license may retain presence; the heartbeat/session
authorization path still gates remote capabilities. End sharing does not
silently revoke an independently authorized startup choice.

Automatic updates are limited to the standard, non-elevated per-user install
at `%LOCALAPPDATA%\Programs\ConnectLive`. Per-machine MSI and custom installation
maintenance is administrator-managed; this work adds no elevation service.
Old machine-owned tasks may require IT removal under their existing authority.

## Build and release contract

`build.ps1` deliberately publishes and stages:

- `ConnectLive.exe`
- `ConnectLiveWatch.exe`
- `ConnectLiveUpdate.exe`

The two installer definitions include all three. The update worker is distinct
from any legacy `Updater.exe`; it is not a service.

Use `-UpdatePublicKeyPath` with a public SPKI PEM for an RSA key of at least
3072 bits. Only the public pin is embedded. A build with no pin is allowed for
source inspection but **automatic updates are disabled**, with a diagnostic
state. Private-key material is rejected as an embedded resource.

`-CreateUpdateBundle` also requires `CONNECTLIVE_UPDATE_SIGNING_KEY_PEM` in the
protected build process. This private key belongs in the signing environment,
not Coolify runtime variables, client configuration, source control or ZIPs.
Request/configure it through secure tooling at the actual release step.
Never launch a production client from a build shell containing signing secrets.

The packager verifies that this key matches the public pin, signs exact manifest
bytes using RSA-PSS/SHA-256 and verifies its own output. Authenticode signing,
when configured, occurs before hashing the runtime files. Manifest signing does
not replace Windows Authenticode, SmartScreen reputation or OS approval.
Public-key rotation requires a controlled installer bootstrap; this protocol
does not silently replace the installed trust anchor from release metadata.

The separate update ZIP contains exactly the three runtime files plus
`manifest.json` and `manifest.sig`. It is **not** the stable installer ZIP/MSI.
The manifest binds product, Windows x64 platform, canonical three-part version,
file lengths and hashes. Download hash, signature, inventory, archive structure
and bounded sizes are all checked. HTTPS ZIP URLs may include query strings;
extension detection uses the URL path. Downloads must be directly served by
the configured gateway origin, without redirects.

Before publishing a runtime release, review/apply only
`supabase/migrations/20261103002000_signed_agent_update_channel.sql` using the
approved migration procedure. It is prepared, not applied by this work. Do
not replay historical migrations. Publish runtime metadata on `stable-update`,
product `agent`; keep installers on stable/beta for manual download.
Legacy checksum-only device updaters receive no installer update payload and
need an installer bootstrap. Technician downloads/native Admin are retained.

## Handoff and recovery

1. An authorized, idle Agent starts background staging; download/verification
   does not block heartbeats. Updates are hourly pull checks, not instant push.
2. The installed worker is copied outside the installation directory. It
   re-verifies the signed package, signals ready and waits for explicit handoff.
3. On a subsequent authorized idle heartbeat the parent records the attempted
   version and handoff, then exits. The worker waits for the exact original
   process to exit; it never kills the original or races its mutex.
4. Complete rollback copies/hashes and journal transitions precede live file
   replacement. Windows renames use write-through; sharing-lock retry is bounded.
5. Candidate creation atomically assigns a suspended process to a kill-on-worker-
   exit job. Identity is journaled before resuming. A worker crash cannot leave
   an unrecorded running candidate holding replaced files.
6. Matching candidate identity/version/nonce, a successful authoritative backend
   heartbeat and a short stability period are required before committing.
   This is launch/connectivity health, **not media parity**.
7. Failure stops only the candidate, restores the validated previous runtime,
   and relaunches only if local and fresh server authorization allow it.
   A pending journal blocks ordinary startup until recovery. Local withdrawal
   prevents relaunch, but does not prevent restoring files.

The attempted-version marker prevents a failed release looping across process
restarts. A deliberate local withdrawal clears that attempt hold after recovery;
otherwise review the failed release and publish a corrected version rather
than repeatedly forcing it. Credentials, grant/configuration formats and
application data must stay backward-compatible during the rollback window:
this updater restores runtime files, not arbitrary data migrations.

State is under `%LOCALAPPDATA%\ConnectLive\updates`; the directory must remain
private to its Windows account. Logs contain status codes, not download URLs
or keys. Terminal staging downloads are removed; rollback inventory remains.
Protect signing and release-publication access separately from device access.

## Mandatory actual-Windows matrix

Use disposable, authorized devices and standard interactive-user sessions.
Do not substitute a Linux cross-build or synthetic media sender.

| Scenario | Required result |
| --- | --- |
| Fresh per-user install | All three executables installed; no startup before opt-in; tray/revocation visible. |
| No opt-in / portable source run | No startup registration or automatic update. |
| Opt-in and logon | Correct Windows user, visible task, least privilege, one Agent/mutex; no repeated session prompts for valid unattended authorization. |
| Crash recovery | Authorized crash restarts after a fresh grant check; planned End sharing does not change startup choice. |
| Server/local withdrawal | Watch cannot restart; sharing/input cease; a late HTTP reply cannot override withdrawal. |
| Healthy signed update | Heartbeats remain responsive during staging; active sessions delay handoff; old mutex exits before candidate starts; health commits. |
| Wrong signer / hash / malformed ZIP | Reject before live files change; same-origin query-string URL still works. |
| Failed copy | Previous runtime restored; journal/evidence preserved; no elevated fallback. |
| Failed launch / missing health | Failed candidate exits, previous runtime restored, no repeat-update loop. |
| Interrupted worker | Terminate during pre-copy, replacement and candidate boot; no orphan candidate; next authorized recovery restores or resumes safely. |
| Withdrawal during update | No relaunch even after rollback; explicit foreground recovery may restore files without restoring access. |
| Standard-user ACL / locked file | Bounded failure/recovery, no ACL bypass or unrelated process termination. |
| MSI installation/upgrade/removal | IT-managed update behavior; native installer compiles; current/other-user legacy registrations reviewed; withdrawal not cleared. |
| Media parity after update | Repeat actual DXGI/GDI→VP8, selected direct/TURN, actions, reconnect and revocation measurements. |

Record real versions, scenario, outcomes and credential-free evidence. Actual
Windows installer/compiler, media, task and kernel behavior remain release gates.
