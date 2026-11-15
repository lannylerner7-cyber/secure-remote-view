# Windows session tools baseline

## Evidence preserved — 2026-11-15

The November 14 log contains **separate 1.10.12 and 1.10.13 runs**.
Their curtain failures and 502s are not 1.10.14 regressions. The November 15
log contains two 1.10.14 launches on Windows 10 build 19045: the first has
device-authentication 401s and DNS failure, while the later launch obtains
authority and starts video. These are not PIN rejection diagnostics.

The owner confirmed the curtain works. At 01:42:26 (lines 251–254) one display
reported capture affinity 0x11, engaged input hooks and an active receipt.
At 02:08:04–05 an explicit administrator action released it. This is not
multi-monitor or secure-desktop acceptance. Preserve the current curtain host.

During the curtain, hardware H.264 counters increased from 204 to 3,402 at
1366×768. This proves encoder output, not delivered FPS, browser presentation
or a selected TURN route. Keep H.264 and the existing JPEG fallback.

At 02:23:47 (lines 1947–1955), signaling and a 20,009 ms heartbeat timeout
caused deliberate authority suspension and transport teardown. Encoder output
was still increasing immediately beforehand. Authority returned at 02:24:02;
WebRTC connected at 02:24:27. Pairing survived; control did not silently resume.

There are 220 logged JPEG deadlines, 53 logged HTTP-200 frames and one
cancellation. These are sampled events, **not a success-rate denominator**.
The terminal paste repeats 1,406 log lines plus a truncated first line; do not
count it as another incident. `server_seen=false` means no diagnostic response
headers arrived, not that the server never received the request.

Slow heartbeat examples include 19,557 ms client / 19,277 ms server, with
runtime reporting, license evaluation and command lookup among slow stages.
Backend correlation is needed before attributing an infrastructure cause.
None of the supplied logs establishes a Hello attempt, installation,
enrollment, prompt type or failure stage; some original paths suppressed errors.
Log timezones are unknown.

## Source reconciliation

Read-only comparison with GitHub main on 2026-11-15 found the relevant curtain,
file, WebRTC, enrollment, console and heartbeat files byte-identical to the
workspace baseline. No upstream changes were overwritten and nothing was pushed.

## Authority map

- Pairing v1 has exactly view, control, clipboard, files and recording keys.
  Do not relax the parser to accept unrelated privileges.
- Parent session permission depends on the accepted grant, runtime/heartbeat
  authority and session lifetime. Each peer forks a permanently revocable child.
  Signaling binds the controller and peer; replacements revoke old callbacks.
- Input pause drains held input but retains video and curtain. Full release,
  local withdrawal and authority loss are distinct operations.
- Unlock is separately opted in, encrypted to a device/grant/key and limited
  to the signed-in user's locked Winlogon desktop. It is not app authentication.
- Folder browsing and microphone sharing need a separately versioned,
  owner-approved local extension, never an implicit expansion of pairing v1.
  Folder access runs as the ordinary Windows user, not the unlock service.
- Screenshot export uses the existing recording/export capability plus fresh
  view authority. It must never export protected or stale frames.

## App/browser Hello compatibility decision

Microsoft's Windows Hello application APIs sign a requesting application's
challenge; they neither reveal PINs/keys nor authorize another application's
request. WebAuthn/passkeys enforce relying-party and user-verification policy.
The existing Winlogon helper cannot reliably attest a browser request,
account and Windows-owned credential target. No cross-application saved-PIN
adapter is enabled. **Approve on the Windows device** is an explicit limitation,
not universal background PIN reuse or a claim of authentication success.

References:
- https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello
- https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/
- https://learn.microsoft.com/en-us/windows/win32/secauthn/credential-providers-in-windows

Runtime Windows acceptance requires an explicitly authorized test machine and
user-run native builds. No production/shared database, customer session,
installer, codec replacement, pricing or payment changes are authorized here.
