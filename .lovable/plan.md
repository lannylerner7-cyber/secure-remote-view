## Short answer: mostly true, but the proposed fix is already in the code

Points 1 and 2 are correct: the Watcher runs as a LocalSystem service (delayed auto-start), so it survives reboots and is not a "startup app", and switching admin clients changes nothing because the failure is local to the target machine.

Point 3 is not the bug. `agent/watcher/Program.cs` already contains exactly the suggested block — it falls back to `_lastLaunchedSessionId` when the heartbeat's `sessions` array is momentarily empty, and stores the id after a successful launch. Applying that "fix" would be a no-op.

## What actually blocks respawn after a manual close

Confirmed from the code and database:

- The Watcher only relaunches the Agent when the heartbeat returns `is_session_active: true`, and heartbeat only counts sessions in `invited/consented/active/paused`. If the session was ended (or the row's state never flips back), the Watcher deliberately writes `stop.flag` and stays idle — no wake path exists at all.
- The web console's Reconnect button only updates the `sessions` row directly from the browser and waits. There is no explicit "wake the agent" command sent to the device, so recovery depends entirely on that state flip being visible on the next heartbeat.
- `LaunchInSession` can return `true` while `process` ends up `null` (`Process.GetProcessById` race). The Watcher then treats the Agent as not running and relaunches every tick — a spawn storm with multiple Agents fighting over one session.
- Manual tray Quit is indistinguishable from a crash; with no wake channel, a user who closes the Agent can leave the machine unreachable until a session state change happens to line up.

## Plan

1. **Add an explicit wake channel (backend)**
  - Extend the `power_commands.kind` check constraint with `wake_agent`.
  - The heartbeat already returns queued/dispatched power commands — the Watcher will consume `wake_agent` directly (no Agent needed to ack it; the Watcher acks via the existing `/api/public/agent/power/{cmdId}/ack` route).
2. **Watcher (`agent/watcher/Program.cs`)**
  - Parse `power_commands` from the heartbeat response; on a `wake_agent` command, launch the Agent in the interactive session immediately regardless of `is_session_active`, then ack the command.
  - Fix the launch bookkeeping: track the returned PID, and if `Process.GetProcessById` fails, keep the PID and re-check with `Process.GetProcessById(pid)` next tick instead of assuming the Agent died. Add a minimum relaunch interval (e.g. 10 s) so a failing launch can never become a spawn storm.
  - Log every launch/skip decision to the event log with the reason, so this is diagnosable on a real machine.
3. **Admin surfaces**
  - Web console `requestReconnect`: keep the session state flip, but also enqueue a `wake_agent` power command for the device, and show "Wake sent — waiting for agent" feedback.
  - Native admin console (`admin/src/Api/ApiClient.cs` already has `EnqueuePowerCommandAsync`): wire the same `wake_agent` enqueue into the reconnect action so both clients behave identically.
4. **Agent**
  - On tray Quit, write nothing that suppresses the Watcher (verify `stop.flag` is not left behind), so a wake command always takes effect.
5. **Repackage** `ConnectLive-RemoteAgent-src.zip` and `ConnectLive-AdminConsole-src.zip` after the changes.

### Technical notes

- No change to enrollment or DPAPI storage; Watcher and Agent already share `%ProgramData%\ConnectLive\device.dat` with `LocalMachine` scope, so both authenticate as the same device.
- The migration is one `ALTER TABLE ... DROP CONSTRAINT / ADD CONSTRAINT` on `power_commands`; no new table, so no new grants or policies are required.

- Exactly as proposed. A persistent, high-privilege background service polls a command queue. When a "launch UI" or "request support" command drops into the queue, the service uses `CreateProcessAsUser` (or similar) to force the UI into the active desktop session.
- **Verdict:** Your `wake_agent` addition to the `power_commands` table is the perfect enterprise-grade solution for this.