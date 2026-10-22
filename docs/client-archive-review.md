# Windows client archive review

## Scope and limits

Read-only review of the two uploaded September 8, 2026 builder archives.
All archive entries were inventoried, checked for unsafe paths/symlinks,
CRC-tested, and compared byte-for-byte with the corresponding files in repository
revision `a743af430f9a7120c62a3e12b4a71bea12a252a3`.
Shared signing files were compared against the repository's root tools/docs.

This is broad subsystem-level source review, not an exhaustive line-by-line
proof, Windows compilation, security certification, or end-to-end route test.
No scripts/executables were run, credentials read, or application endpoints called.

## Archive evidence

| Archive | Files | Compressed bytes | Result |
| --- | ---: | ---: | --- |
| Agent Installer Builder | 49 | 189563 | CRC/path checks pass; source/build package |
| Admin Release Builder | 53 | 178161 | CRC/path checks pass; source/build package |

SHA-256:

- Agent: `82c83795b57be3c64d624df4c10681b966a05e44cea24d80ba76608be836e1a3`
- Admin: `e4eafac26483d01016a227db718b725f8f3563b7446f954ec2e1e23ebd18b3fb`

These hashes identify the received files; they do not establish trusted publisher
provenance. Neither archive contains an executable, MSI, APK or AAB.

### Repository comparison

- Admin: 52 matching files and one archive-only build instruction file.
- Agent: 46 matching files, two differing source files (`src/InputRelay.cs`,
  `src/StartupSelfHeal.cs`), and one archive-only build instruction file.
- The agent archive does **not** contain the repository's Watch project.
  Its startup recovery differs from the repository; do not attribute the
  repository's watchdog packaging to this uploaded archive.
- Admin rendering spike/test projects are in the repository but not the upload.

## Understanding of the clients

| Subsystem | Agent | Admin | Review status |
| --- | --- | --- | --- |
| Application | Windows .NET 8/WPF, version 1.9.1 | Windows .NET 8/WPF, version 1.7.2 | Project declarations inspected; builds untested |
| Identity | Meeting-ID enrollment, per-device credentials, DPAPI storage | Login, token renewal, DPAPI user token storage | Client source inspected; backend policy unverified |
| Session lifecycle | Heartbeats, invitation acceptance, pause, resume, teardown | Device list, session actions, live-session viewmodel | Source reviewed, runtime transitions untested |
| Media | Desktop capture, JPEG fallback, WebRTC, H.264/VP8 components | WebRTC decoding, D3D/WPF presentation, frame fallback | Architecture reviewed; codecs/hardware untested |
| Input | Closed event dispatcher and local input-block release mechanisms | Mouse/keyboard translation and transport switching | Defensive boundaries reviewed; execution untested |
| Clipboard/files | Separate session channels and incoming file staging | Transfer, receive and cloud-file operations | Privacy/integrity risks identified below |
| Updates | Manifest/checksum download and binary replacement | Release metadata retrieval | No publisher-trust or runtime certification |
| Packaging | Inno/MSI/enterprise templates and signing helper | Release packaging and signing helper | Scripts inspected, never executed |

## Principal defensive findings

### 1. Consent disclosure contradicts invitation handling

The splash promises that screen sharing will always ask first; the invitation
handler automatically submits acceptance. The Meeting ID prompt has no explicit
unattended-access grant. Foreground splash visibility is temporary and background
launches have no ongoing session-status UI.

Evidence: agent `src/SplashWindow.xaml.cs:97`, `src/Agent.cs:453-459`,
`src/MeetingIdPrompt.cs`, `src/App.xaml.cs:128-149`.

Prior informed consent could support an unattended model, but this source does
not demonstrate the disclosed grant or reliable local withdrawal UI.

### 2. Startup choice and uninstall need honest validation

The Inno autostart checkbox controls scheduled-task registration, while its own
comment states that agent startup recovery is unaffected. Uninstall does contain
explicit task/process/firewall cleanup; it would be inaccurate to say uninstall
does not exist. Removal of all per-user recovery entries and preservation of a
deliberate opt-out remain unverified.

Evidence: agent `packaging/inno/ConnectLiveSetup.iss:55-60,82-95`,
`src/StartupSelfHeal.cs`.

### 3. Pause and authorization loss are not established privacy stops

Pause cancels HTTP capture/input/cursor loops but retains the peer connection.
Independent clipboard/file handlers and direct input ingress are not visibly
gated by pause in the inspected client code. The inspected input receivers also
do not demonstrate an independent view-versus-control permission boundary.

Normal teardown exists, and input-block watchdog/release paths exist. Those are
positive controls, not proof that authorization loss closes every channel.
Three heartbeat failures release input blocking/curtain but do not themselves
terminate the entire peer session. Revocation requires backend and device tests.

Evidence: agent `src/Agent.cs:270-285,415-425,486-516`,
`src/WebRtcSession.cs:293-345,778-804`,
`src/ClipboardRelay.cs:41-70`, `src/InputBlocker.cs:183-194`.

### 4. Clipboard, recording and file retention need explicit scope

The clipboard relay automatically synchronizes text after its channel opens;
no independent permission gate is shown in that relay. Admin local recording
does not show an endpoint notification handshake in the inspected path.
The Admin file-receive callback also uploads received content to cloud storage.
Local consent, recording notice, retention and deletion policy need separate
verification rather than assuming session authorization covers every action.

Evidence: agent `src/ClipboardRelay.cs:41-70,93-145`;
admin `src/ViewModels/LiveSessionViewModel.cs:887-900,933-965`.

### 5. File integrity wording exceeds implementation

The agent computes and logs a received-file digest but does not compare it
against an expected sender digest in completion. This is not the independent
SHA-256 verification promised by its header. Filename sanitization, staging and
agent-side size bounds do exist. On Admin, the nominal 500 MiB rejection occurs
after data materialization in the reviewed receive path, leaving a resource
exhaustion concern.

Evidence: agent `src/FileTransfer.cs:25,64-88,146-217`;
admin `src/Media/FileTransport.cs:180-224` and
`src/ViewModels/LiveSessionViewModel.cs:887-900`.

### 6. Credential and update trust have limits

Agent DPAPI storage uses machine scope, while Admin uses current-user scope.
Machine-scope encryption alone does not establish isolation between local users;
actual ACLs need inspection on Windows. Admin logout clears local tokens but
the inspected method does not perform server-side revocation.

Agent updates compare a downloaded package to a manifest checksum. The inspected
updater does not independently establish trusted publisher identity; an expected
hash supplied by the same release authority is not a substitute for publisher
signature verification. Signing helpers are present, but no signed binaries were
supplied and no signatures were verified.

Evidence: agent `src/ApiClient.cs:666-710`, `src/SelfUpdate.cs:61-158`;
admin `src/Api/AuthStore.cs:24-64`, `src/Api/ApiClient.cs:140-193`.

### 7. Documentation and release assertions need reconciliation

Some comments still describe interactive consent, tray notices, or behavior not
shown by current execution paths. Builder instructions and script interfaces
also differ. Packaging success and code-signing cannot be inferred from included
scripts: optional signing can leave unsigned outputs.

These are review findings, not a repaired or validated distribution pipeline.

## Remaining verification

- Windows compilation, installer/upgrade/uninstall, real ACLs and signature checks.
- Consent accept/deny/withdrawal, explicit unattended grant and local stop.
- Every independent channel stopped on pause, revoked access and session end.
- Backend authentication, tenant ownership, RLS, storage and release policies.
- Safe handling of hostile/oversized media, transfer and input data.
- Native rendering/interop memory safety, concurrency, dependency vulnerabilities.
- Network loss, stale sessions, power transitions and hardware/codec compatibility.
- Complete route/caller coverage, including direct Supabase and server functions.

Neither archive supplies backend handlers, migrations or Android app source.
Those components cannot be verified from these two packages alone.

## Conclusion

The uploads substantially clarify the Windows implementation and confirm that
the source packages are structurally readable. They do not demonstrate successful
builds, correct execution, informed consent or end-to-end authorization. Continue
with defensive review and transparent consent/withdrawal design, not activation
of the unchanged hidden-access behavior.
