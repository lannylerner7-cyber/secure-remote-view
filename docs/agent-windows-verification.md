# Agent 1.10.1 — Windows acceptance checklist

## Installation and update scope

The per-machine MSI uses protected installation files. Its upgrades remain
IT-managed Windows Installer operations: the unprivileged updater must not
replace Program Files or elevate itself. Test signed in-place updates in a
user-owned installation using the documented publisher-key build configuration
for both versions. The unsigned test-MSI command below does not establish
publisher trust for updates.

This source ZIP is not a backend deployment package. Apply the matching
migrations and deploy the web code from the full updated repository before
testing browser lifecycle operations. Neither has been deployed by this change.

Uninstall rollback must not silently undo a local access withdrawal already
recorded by the user.

## Checks completed in this workspace

- Agent, Watch and update-helper Windows-target cross-builds: zero errors.
  Agent retains three existing warnings; Watch and update helper have none.
- Portable native checks previously passed: 25 lifecycle, 22 gateway,
  15 peer-lifecycle and 46 signed-update/transaction model checks.
- Web TypeScript checking and production build passed.
- 22 browser/lifecycle policy checks passed.
- Disposable PostgreSQL: 21 foundation checks and 26 lifecycle checks passed
  using the real migrations, authorization predicates and RLS.
- Production database and deployed applications were not modified.

These checks do not prove Windows media, installer operation, physical input
behaviour, signed-in browser/device interaction or native update recovery.

**Status: Windows execution not performed in the Linux workspace.**
Use a Windows test device you control, not a production fleet. Keep a physical
keyboard available. Do not retire the native Admin until measured browser parity
and explicit cutover approval.

## Build and install

1. Deploy the matching backend/migration first; see
   [agent-lifecycle-implementation.md](agent-lifecycle-implementation.md).
2. Install the Windows .NET 8 SDK. Extract the **entire** Agent source ZIP.
   In PowerShell, from its `agent` folder:

   ```powershell
   .\build.ps1 -Version 1.10.1 -SkipInno -SkipSign
   ```

   This builds an **unsigned test MSI** with pinned WiX 4.0.6 and matching
   extensions. Production distribution requires your signing identity. It does
   not suppress SmartScreen. To build the Inno installer too, install Inno Setup
   6 on PATH and omit `-SkipInno`.
3. Install `agent\dist\ConnectLiveAgent.msi` through Windows normally. Confirm
   Agent, Watch and update helper are present. Check the generated deployment
   metadata against the MSI's actual ProductCode/version.
4. Launch interactively, use a newly generated device pairing code, read the
   disclosure and deliberately choose whether startup/recovery is enabled.
   Confirm one device and one recorded grant, not duplicate enrollments.
5. Confirm a later authorized background launch does not ask for pairing again.
   A source-only `dotnet run` does not package Watch or validate installation.

## Recovery and presence — not yet verified on Windows

- With startup **off**, neither logon nor browser relaunch may start the Agent.
- With startup **on**, sign out/in and reboot. Check the visible current-user
  startup registration and Watch task; no SYSTEM capture/service or power scope.
- Leave the device idle for more than two minutes: no false stale status at 30s.
- Stop the Agent through Task Manager. Observe a stopped/recovery state followed
  by a new process and a real heartbeat. A “starting” receipt is not success.
- Click web “Relaunch Windows Agent” while absent. Record click, Watch receipt,
  launch and healthy-check-in times. Repeat while healthy: no duplicate or kill.
- Kill Watch alone. Verify the opted-in scheduled task restores it, and an
  interrupted command is safely resumed without duplicate Agents.
- Block networking, restart the web process and interrupt SSE. Verify backoff,
  fallback reports, reconnect and accurate offline/unknown states. Watch alive
  alone must not display the Agent as online.
- Cause repeated launch failures. Verify bounded retries, readable failure state
  and a deliberate retry after correcting the cause.
- Disable access locally, revoke it on the server, replace the grant and remove
  startup permission. Queued and delayed commands must not override any of them.
- Uninstall through both supported installers. Observe removal **requested** if
  delivered; no claim of completion from silence. Verify files, tasks, Run key,
  process state and device-list wording locally, including offline uninstall.
- Check MSI repair, reinstall, major upgrade, uninstall cancellation/rollback,
  custom install locations, multiple Windows logons and Windows
  Installer/Restart Manager interaction, including cleanup for logged-out users.
  A failed removal must not silently restore withdrawn authorization.

## Curtain and live media — not yet verified on Windows

- Use a decoded VP8 video session with control permission. Toggle curtain:
  confirm local notice rendering **before** the applied receipt/input pause.
- Compare the physical device with both DXGI and forced-GDI streams: the notice
  must be physically visible and absent from the remote video.
- Test every monitor, mixed DPI, portrait orientation and display changes. Check
  remote pointer mapping and release on display reconfiguration.
- Test physical keyboard/mouse pause and authorized remote input. This does not
  promise to block Windows secure attention, secure desktop or hardware actions.
- Press physical Ctrl+Alt+Shift+Esc: input must release and access must stop.
  A remote/injected copy of that chord must not be treated as physical consent.
- Stop renewals, disconnect the data channel, close the browser, lose networking,
  revoke control and force competing-technician takeover. Measure release time.
  The configured five-second lease is not a hard real-time scheduling guarantee.
- Toggle off and on repeatedly. Reject late receipts from old peers/grants.
  Failed display exclusion/hook installation must not produce an “active” UI.
- Measure first decoded frame and steady-state glass-to-glass latency, direct
  and forced TURN, packet loss/reconnect, capture/encode CPU, memory and idle
  overhead. Record selected ICE candidate **types/protocol** and decoded-frame
  counts; redact IP addresses, SDP, ICE credentials, pairing codes and tokens.
- Verify clipboard, files/checksums, recording and local/server revocation per
  the existing browser-first checklist. Do not substitute successful signaling
  or relay allocation for video evidence.

## Signed update and rollback — not yet verified on Windows

- Supply the intended publisher **public** trust pin at build time. Keep the
  signing private key outside the source ZIP. Missing trust disables updates.
- Test valid, wrong-publisher, modified, downgrade, oversized and interrupted
  packages, including a signed HTTPS ZIP URL with query parameters.
- Confirm Agent and resident Watch exit before file replacement. Verify the
  replacement obtains the Agent mutex and a real launch-health check.
- Terminate the worker after the terminal journal write but before marker
  cleanup. Recovery must clear the pending marker and restore Watch operation.
- Inject failed copy and failed launch/health checks; verify restoration and
  durable recovery after termination/reboot. Do not count Process.Start as proof.
- Withdraw access during staging, handoff and recovery: no relaunch may override
  local disable. Test supported per-user updating separately from MSI-managed
  Program Files installations; do not introduce elevation to write there.

For each case record Windows build, Agent version, backend version, test time,
expected/actual behaviour and redacted evidence. Until these pass, the source
bundle is for validation—not a claim of unattended production reliability.
