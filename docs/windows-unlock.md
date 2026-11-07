# Authorized Windows lock-screen access

## Delivery and verification boundary

This is a **source-only implementation**, not a certified Windows release.
It has not been compiled, installed, or exercised against a Windows Hello
sign-in screen in this workspace. Do not bundle it into an MSI or enable it on
production endpoints until the designated-Windows checks below pass.
No shared/production database migration is applied automatically.

Supported intent: an **already signed-in Windows 10/11 user whose session is
locked**. The interactive Agent must still be running. This does not provide
BitLocker/preboot access, cold-boot sign-in, password resets, UAC approval,
biometric extraction, Windows Hello key extraction, or an authentication bypass.
Unknown desktop, account, permission, helper, or lock states fail closed.

The requested credential is a **Windows Hello PIN**, explicitly entered by the
operator, not an account password. Windows still decides whether it is valid.
Saving a reusable PIN reduces the protection of a device-only Hello PIN; both
the local enable prompt and Admin's save form disclose that tradeoff.

## Acceptance status — 2026-11-07

**BLOCKED — no designated Windows test device/account is available.** The user
confirmed that no test device is available. The workspace runs Linux, which
cannot provide the required Windows runtime evidence.

All designated-Windows checks below remain **not run / not verified**, including
both the web console and native Admin. This assessment performed no native
compilation, service installation or actual Windows Hello unlock. It did not
test production devices, apply a shared database migration, bundle an installer
or enable production access. Synthetic receipts and existing automated checks
are not substitutes for those missing results.

**Release decision: not approved.** The implementation remains source-only.
Do not bundle it into an MSI or enable it on production endpoints.

To resume, designate a specifically authorized, disposable Windows 10/11 test
device/account and a local administrator for explicit helper installation. The
user must run the native builds manually, then complete every designated-Windows
check below and record the actual results before release approval. Evidence
must never contain actual PINs, tokens, keys or credential-bearing screenshots.

## Enrollment and local service

1. Pair the Windows Agent normally, with disclosed **unattended view and
   control**. Existing grants do not implicitly grant lock-screen access.
2. Install the manually built Agent in
   `%ProgramFiles%\ConnectLive\ConnectLive.exe`. The executable and installation
   directory must be owned by SYSTEM, Administrators, or TrustedInstaller and
   must not be writable by ordinary users. Junctions/reparse points are
   rejected. Running an executable from Downloads or `dotnet run` is not enough.
   Have a local administrator correct an improperly owned/writable installation;
   the service installer deliberately does not silently change unrelated Agent
   files or their permissions.
3. As the paired Windows user, run:

   ```powershell
   & "$env:ProgramFiles\ConnectLive\ConnectLive.exe" --unlock-setup
   ```

   The dialog identifies a local `unlock-setup.json` containing only the device,
   grant, server origin, Windows SID, Agent path and executable hash. It contains
   no token, PIN, or private key.
4. On your Windows build machine, manually build the helper from reviewed
   source. **These are user-run commands; they were not run in this workspace.**
   From `imports/connectlive`:

   ```powershell
   dotnet publish .\agent\unlock\ConnectLiveUnlock.csproj -c Release -r win-x64 `
     --self-contained true -o .\agent\unlock\bin\approved
   ```

   Build the updated Agent and Admin using your usual source-build process.
   Do not invoke installer/MSI bundling as a substitute for these runtime tests.
5. The local administrator reviews the helper source, hashes and installation
   script, then explicitly runs an elevated PowerShell:

   ```powershell
   .\agent\unlock\Install-ConnectLiveUnlock.ps1 `
     -SetupFile "<path shown by --unlock-setup>" `
     -HelperExe ".\agent\unlock\bin\approved\ConnectLiveUnlock.exe"
   ```

   It asks for `ENABLE`. The LocalSystem service trusts only the fixed,
   protected Agent executable hash and the exported SID/device/grant/origin.
   Its policy and single-file runtime extraction directory are
   administrator/SYSTEM-only. It does not change UAC, Secure Attention
   Sequence policy, autologon or Windows credential configuration.
6. Back as the paired Windows user:

   ```powershell
   & "$env:ProgramFiles\ConnectLive\ConnectLive.exe" --unlock-enable
   ```

   Approve the separate disclosure. This creates an RSA-3072 identity protected
   with DPAPI CurrentUser. Enabling again rotates the key and removes the old
   saved PIN; the operator must save it again. An unchanged pending enrollment
   can be explicitly resumed after an uncertain registration response.

The ordinary Agent still runs unelevated and keeps its pairing-only UI. There
is no hidden installation, elevation, startup consent, or automatic unlock.
Agent executable updates intentionally invalidate the service hash approval:
repeat local setup before using the helper again.

## Database rollout

The additive migration follows the reviewed browser-first and Agent lifecycle
migrations. It does not alter pairing notice version 1 or expand old grants.

Review:

```sh
node scripts/apply-windows-unlock.cjs --dry-run
node tests/local-agent-lifecycle-database.cjs --windows-unlock
```

The second command creates disposable Unix-socket PostgreSQL, applies the real
baseline/trigger chain there, tests synthetic records, and rolls back the
unlock schema and records. It never reads a remote database URL.

For an explicitly approved target only, the migration runner supports
`--check` (transaction rolled back) and `--apply` (commit) using the project's
existing migration connection mechanism. Do not run either against a shared
database as an implicit test. Existing reviewed migration history is checked
before reusing a migration version. The SQL file is
`supabase/migrations/20261107000000_windows_unlock.sql`.

## Admin operation

Web: select one Windows device → **More → Windows lock-screen access**.
Windows Admin: **Windows PIN** on the device row, or **Windows PIN settings**
in a live session.

An authorized device manager can explicitly save, replace, or forget the PIN,
or revoke lock-screen permission. PIN fields are masked and cleared after
submission/closure. There is no reveal/copy/download action, auto-fill from
Windows, logging, browser storage, plaintext API field, or local PIN cache.
Browser/managed-runtime strings cannot be guaranteed physically erased from
memory; sensitive byte buffers are cleared where the APIs permit.

Start an authorized live session, then click **Unlock Windows**. Secure input
is blocked from ordinary transport before asynchronous preparation begins.
Recording is stopped, pending input is discarded, and the session becomes
view-only. The helper captures only the current session's trusted lock UI on
the locked Winlogon desktop. Secure pixels use WebRTC, never JPEG fallback,
HTTP frame storage, or recording. Clipboard and file channels are not
lock-screen input paths.

Select the correct Windows account and an **empty Windows Hello PIN field** on
the visible screen. Type directly, or explicitly confirm **Use saved PIN once**.
The saved PIN is injected only into a verified password field belonging to
SYSTEM LogonUI. The helper does not guess focus, choose an account, or extract
an existing field value. Ctrl+Alt+Delete is an explicit best-effort request
subject to Windows policy, not a promise that the OS accepted it.

Only a fresh Windows session-state query can produce “Windows reports
unlocked.” A successful send, permission update, picture, or wrong PIN cannot.
Uncertain/failed submissions are never automatically repeated. An attempt has
a two-minute limit, five-second leases, one saved-PIN retrieval, and server
spacing/attempt-rate limits. No pending PIN or input is replayed after peer
replacement, connection loss, local withdrawal, logout, or revocation.

Unlock success returns to **view-only**, without automatically restoring
control or curtain. Ordinary control requires an explicit new request.
Close and reopen the viewer before recording again: the viewer that received
secure pixels deliberately cannot start another recording from retained
secure-screen buffers.

## Storage, removal and recovery

Admin seals the PIN using random AES-256-GCM, with its key wrapped using the
enrolled Agent's RSA-OAEP-SHA256 public key. Authenticated context binds it to
the device, grant and key identity. The database stores only that envelope.
The private key stays DPAPI-protected on the paired Windows user's computer;
the Agent retrieves ciphertext once and decrypts just in time. It does not
persist a second reusable PIN file.

Requests bind to the device, grant, session, current Admin-client binding and
WebRTC peer. A viewer, another organization, stale grant, old key, changed
session binding, or unavailable authority cannot use the credential. Only the
server's service role can access vault tables/RPCs directly.

Deleting the device removes its active encrypted credential, unlock permission
and attempts. Revoking the base grant also removes unlock data. Minimal
token-hash-bound tombstones let an offline Agent remove its old encryption
identity on reconnect. A transient error or generic HTTP 401 is **not** evidence
of revocation and never erases pairing or key material.

This does not promise immediate offline wiping, secure deletion from disk,
automatic application uninstall, or erasure from retained backups. Restoring
an older database backup can restore old authorization records; disable and
reapprove Windows unlock before reopening traffic after such a restore.

Local withdrawal:

```powershell
& "$env:ProgramFiles\ConnectLive\ConnectLive.exe" --unlock-disable
```

This removes the local unlock identity and makes a best-effort server revoke.
If offline, revoke in Admin too when possible. Local filesystem failures are
reported, not treated as a successful wipe. The Agent's ordinary `/disable`
also clears unlock enrollment. To remove just the service, a local
administrator explicitly runs the installer script with `-Remove`, confirms
`REMOVE`, and follows its enrollment-revocation warning.

## Required designated-Windows checks before release

Use a consenting disposable Windows account/device and synthetic credentials.
Do not infer these results from Linux checks or simulated browser receipts:

- Manually compile Agent, Admin and helper, and test standard-user Agent plus
  separately elevated service installation on supported Windows 10/11 builds.
- Verify protected-path, ACL, hash, SID, session, origin, grant and pipe identity
  checks, including a wrong process and writable/junction installation paths.
- Lock an already signed-in user; prove increasing secure frames, correct
  pointer coordinates, manual Unicode/PIN input and actual OS-confirmed unlock
  in both clients. Test Windows Hello auto-submission and desktop transitions.
- Wrong PIN, wrong account/field, non-empty field, policy/Hello rejection, SAS
  denial, missing helper, unknown desktop and UAC foreground all fail without
  automatic retry or spillover into an ordinary application.
- Test cancellation during preparation and input, peer/ownership takeover,
  network loss and gateway errors. No sensitive REST rows, HTTP/JPEG frames,
  clipboard writes, recordings or queued-input replay may be produced.
- Stop recording before secure capture; cancel/unlock and confirm view-only
  return, released keys and curtain, and the recording guard.
- Exercise save/replace/forget/revoke/delete while online and offline. Verify
  deletion receipts clear only the matching local identity and that transient
  failures do not erase pairing.
- Check updates invalidate helper approval, local withdrawal remains effective,
  service removal leaves no running helper, and restored backups are not
  allowed to silently restore unlock authority.

Current automated checks:
`tests/windows-unlock.cjs`, `tests/windows-unlock-database.cjs`,
`tests/native-streaming-regression.cjs`, and `tests/control-curtain.cjs`.
The development-only browser fixture
`tests/windows-unlock-browser.tsx` exercises real React/crypto/controller code
with in-memory synthetic endpoints; it is not an app route or Windows proof.
