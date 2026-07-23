## Updated direction

You're right: after a reboot, the user should not have to type a new join code if the original admin session is still valid. The 6-digit code already lives in the database on the session, and `pair.ts` is already written to be idempotent for `invited`, `active`, and `paused` sessions. We should use that instead of creating a new rejoin flow.

## What we will build

### 1. Persist the one-time reusable pairing state on the agent

- After the first successful join, the agent stores the successful `sessionId` and `pairingCode` locally under `%ProgramData%\ConnectLive` using DPAPI-protected storage.
- On reboot/startup, the agent first tries to reconnect using the stored session/code before showing the Join window.
- If the server accepts it, the agent immediately starts screen capture, input relay, cursor pump, and WebRTC/HTTPS fallback again.
- If the server rejects it because the admin ended the session.  or if the code was cleared, the agent create a retry mechanism using the existing stored join data in DPAPI storage state and auto rrfresh its token meetin multiple time ang get signal unless if admin as terminate the session / End 

### 2. Keep the admin session intact and make it reconnectable

- Do not create a new session after reboot.
- Keep the existing session row `active` or `paused` as the source of truth.
- Admin panel should continue showing the same session and switch the status to reconnecting/offline based on heartbeat age.
- Add a clear **Reconnect** action in the admin live/session panel that re-uses the existing `pairing_code` and waits for the installed agent service to come back online.

### 3. Add a safe agent reconnect endpoint

- Add an authenticated agent route like `POST /api/public/agent/session/{sessionId}/reconnect`.
- It verifies the device token, confirms the session belongs to the same device, and confirms the session is still `invited`, `active`, or `paused`.
- It returns the session mode/state and refreshes `devices.last_seen_at`.
- This avoids relying only on a human-entered code after reboot while still preventing another device from hijacking the session.

### 4. Fix startup service packaging

- Update the zip packaging so the bundle contains both:
  - `ConnectLiveAgent.exe`
  - `ConnectLiveWatcher.exe`
  - `install.ps1`
  - clear install instructions
- The watcher service must be installed once with elevated PowerShell; after that it starts on boot and spawns the agent in the user desktop session.
- Add install/status documentation so you can verify with one command that `ConnectLiveWatcher` is installed and running.

### 5. Wake-on-LAN clarification

Wake-on-LAN is not what makes the agent restart after reboot. The Windows service does that.

Wake-on-LAN only helps when the PC is asleep or powered off, and it requires:

- NIC/BIOS Wake-on-Magic-Packet enabled on the target PC.
- Another already-online device on the same LAN to broadcast the magic packet.

We can add Wake-on-LAN after reboot reconnect is stable, but it should be treated as a separate LAN wake feature, not the core startup/reconnect fix.

## Technical implementation notes

- `agent/src/ApiClient.cs`: add `ReconnectSessionAsync(sessionId)` and DPAPI helpers for saved join state.
- `agent/src/App.xaml.cs`: before showing `JoinWindow`, try saved session reconnect; only show the Join window if reconnect fails.
- `src/routes/api/public/agent/session.$sessionId.reconnect.ts`: new server route secured by `verifyDevice`.
- `src/routes/_authenticated/admin.tsx`: preserve the existing session, show reconnecting state, and add a reconnect/waiting affordance instead of forcing a new code.
- `agent/build.ps1` and `agent/install.ps1`: package and verify the watcher service so startup works after reboot.
- Rebuild and export the updated `ConnectLiveAgent.zip`.

## Result

The user joins once. After reboot, the installed service starts the agent, the agent reuses the existing stored session/code, and the admin panel reconnects to the same live session without making the user type the code again.