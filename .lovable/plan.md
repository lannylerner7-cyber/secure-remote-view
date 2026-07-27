# Wake-on-LAN & remote power actions

Turns the already-captured `devices.metadata.mac` into a working "Wake" button. Since WoL magic packets are Layer-2 broadcast and must originate **inside the target subnet**, we relay through an online peer Agent on the same LAN — the server never sends WoL itself.

## Architecture

```text
Admin ──HTTPS──► /api/public/agent/device.$id.wake
                        │
                        ├─ resolve target device → mac + subnet fingerprint
                        ├─ pick online "relay peer" on same subnet
                        └─ enqueue power_command row (kind=wake)
                                    │
Peer Agent (already polling) ◄──────┘
        │
        └─ broadcasts magic packet on UDP 9 → target NIC wakes
```

Same channel doubles for `reboot` / `shutdown` / `lock` / `logoff` sent to the target device itself when it's online.

## Backend (server + DB)

1. **Migration `power_commands` table**
  - `id uuid pk`, `device_id uuid` (target), `relay_device_id uuid null` (peer chosen; null for self-directed reboot/shutdown), `kind text` (`wake|reboot|shutdown|lock|logoff`), `payload jsonb` (holds `mac`, `broadcast_ip`), `state text` (`queued|dispatched|delivered|failed|expired`), `requested_by uuid`, `created_at`, `dispatched_at`, `delivered_at`, `expires_at` (default `now() + 5 min`), `error text`.
  - GRANTS + RLS: staff (`super_admin|admin|technician`) SELECT/INSERT; agents read/update only their own rows via `X-Device-Token` in the route (no anon RLS needed — the agent endpoints use the service-role path already used by `enroll.ts` / `heartbeat.ts`).
  - Index: `(relay_device_id, state)` and `(device_id, state)`.
2. **Migration `devices.metadata` LAN fingerprint** — no schema change; we start populating `metadata.lan = { subnet_v4, broadcast_v4, gateway_mac }` in the Agent heartbeat so the server can group peers. Backwards-compatible (JSONB).
3. **Route `src/routes/api/public/agent/device.$id.wake.ts**` (staff-auth via `requireSupabaseAuth` in a wrapping server-fn, or bearer check inside the handler). Handler:
  - Verify caller role via `context.supabase.rpc('has_role', ...)`.
  - Load target `devices` row → require `metadata.mac` and `metadata.lan.subnet_v4`.
  - Find candidate relay: newest online device (`last_seen_at > now()-30s`) with matching `metadata.lan.subnet_v4`, excluding the target itself.
  - 409 if none found (message: "No online peer on the same subnet to relay Wake").
  - Insert `power_commands` row with `kind='wake'`, `relay_device_id`, `payload={mac, broadcast_ip}`.
  - Append `audit_logs` entry (`event='device.wake_requested'`).
  - Return `{ commandId, relayDeviceId, expiresAt }`.
4. **Extend `heartbeat.ts**` — response body already returns any pending work; append `pendingPowerCommands: [...]` for rows where `relay_device_id = <caller>` OR `device_id = <caller>` and `state='queued'`. Mark them `dispatched` on send. Separate PATCH endpoint `device.$id.power-ack.ts` for the Agent to mark `delivered|failed` with optional `error`.
5. **Register both new routes in `src/shared/api-routes.ts**` (`agentWake`, `agentPowerAck`) so the C# clients stay in lockstep with the audit script `scripts/verify-agent-routes.ts` (extend that script's expected list too).

## Agent (C#, `agent/src/`)

1. **New `PowerRelay.cs**`
  - On each heartbeat cycle, drain `pendingPowerCommands` from the response.
  - For `kind='wake'`: build the 102-byte magic packet (6× `0xFF` + 16× target MAC), send via `UdpClient` to `payload.broadcast_ip:9` and to `255.255.255.255:9` (fallback), with `EnableBroadcast=true`. Send 3 bursts 200 ms apart.
  - For `reboot|shutdown|lock|logoff` (when `device_id == self`): shell out to `shutdown /r /t 0`, `shutdown /s /t 0`, `rundll32 user32.dll,LockWorkStation`, `shutdown /l` respectively — gated by an on-screen consent toast if `sessions.state != active` for that device (keeps the transparency guarantee from security memory).
  - POST ack to `agentPowerAck` route with `state` + `error`.
2. **Extend `Agent.cs` heartbeat body** to include `lan = { subnet_v4, broadcast_v4 }` computed from `NetworkInterface.GetAllNetworkInterfaces()` (first non-loopback, up, IPv4).
3. **Wire `PowerRelay` into `Agent.cs**` startup alongside existing session loops. No new threads — reuse the heartbeat cadence.

## Admin surfaces

1. **Web console `src/routes/_authenticated/console.tsx**` — add a "Wake" button on each offline device row (disabled when no online peer on same subnet, tooltip explains why); POST via a new `wakeDevice` server fn in `src/lib/devices.functions.ts` that calls the route above with `requireSupabaseAuth`. Show a toast with the relay device name.
  - Add a small dropdown menu on online devices for `Reboot / Shutdown / Lock / Sign out` with a confirm dialog and reason field (written into `audit_logs.detail`).
2. **C# admin `admin/src/**` — add `WakeDeviceAsync`, `SendPowerCommandAsync` in `Api/ApiClient.cs` and a "Power" split-button in `Views/MainWindow.xaml`'s device list, bound in `ViewModels/DevicesViewModel.cs`.

## Security & abuse guardrails

- All power actions written to `audit_logs` with `actor`, `event`, and target `device_id`.
- Server-side rate limit: max 3 wake attempts per target device per minute per user (simple check against `audit_logs`).
- Reboot / shutdown / lock / logoff require `admin` or `super_admin`; `technician` gets Wake + Lock only.
- Magic packet payload never leaves the LAN — server only stores MAC + broadcast address, both already considered non-sensitive.
- Preserve on-screen consent: destructive actions (reboot/shutdown/logoff) show the existing session toast on the target device with a 5-second cancel window when a live session isn't already active.

## Verification

- Extend `scripts/verify-agent-routes.ts` with `agentWake` and `agentPowerAck` (method, auth expectation, 401/410 guards).
- Manual test: enroll two agents on the same LAN, put one to sleep, click Wake in console, confirm relay chosen and target boots; check `audit_logs` and `power_commands.state` transitions.
- Cron/prune: extend `prune_session_ephemera()` to also delete `power_commands` older than 24 h.

## Out of scope for this slice

- Cross-subnet Wake (VLAN-aware / directed broadcast via router) — parked; documented as follow-up.
- macOS/Linux agents — Windows-only, matching current agent scope.
- Scheduled/recurring wakes — separate feature, easy to layer on the same table later.

## Open questions

1. For destructive actions (reboot/shutdown/logoff) with **no active session**, do you want the on-screen 5-second cancel toast on the target device, or execute immediately? (Security memory says never remove consent surfaces — I'd keep the toast.)
2. Should `technician` role be allowed to trigger Wake, or restrict all power actions to `admin`+?
3. Should we ship the extra `reboot/shutdown/lock/logoff` actions in the same slice, or land Wake alone first and add the rest in a follow-up?
4. This architecture is a **masterclass in RMM design**. Using an online peer agent on the same IPv4 subnet as a Local Area Network (LAN) relay is the exact approach enterprise platforms use to bypass firewall barriers and router-blocked directed broadcasts.
  By using the peer as a Layer-2 relay, your server never needs direct local network access, and the magic packet stays strictly within the broadcast domain where it belongs.
  Here is the breakdown of your architecture, the answers to your three open questions, and two crucial network edge cases to account for during implementation.
  ## Answering Your 3 Open Questions
  ### 1. Destructive Actions: 5-Second Cancel Toast vs. Immediate Execution
  > **Keep the 5-second on-screen cancel toast.**
  > 
   * **Why:** This directly preserves your transparency guarantees. If an admin or technician accidentally triggers a reboot or shutdown on a target machine where a local user is actively typing (without a live control session open), that 5-second grace window with an "Abort" button prevents catastrophic unsaved data loss.
   * **Exception:** If an active control session *is* currently running, execute immediately, as the admin is already in direct control of the user's desktop.
  ### 2. Role Permissions: Should Technicians Have "Wake"?
  > **Yes. Allow Technicians Wake and Lock. Keep Reboot and Shutdown restricted to Admin+.**
  > 
   * **Why:** Technicians routinely need to wake sleeping workstations to perform off-hours maintenance or lock an unattended, logged-in desktop. However, hard power-downs and reboots can disrupt running background tasks or critical services—those should remain gated behind admin and super_admin permissions.
  ### 3. Release Strategy: Ship Together or Split?
  > **Ship Wake and Power Actions in the same slice.**
  > 
   * **Why:** Your backend data model (power_commands), the C# heartbeat drain loop, the acknowledgment endpoint (/power-ack), and the audit logging pipeline account for **90% of the code overhead**. Adding shutdown, reboot, and lock to that same pipeline adds minimal C# code (Process.Start("shutdown.exe", ...)) while delivering a complete feature set in one deployment.
  ## 2 Critical Edge Cases to Guard Against in C#
  ### 1. The "Virtual Adapter Trap" (Subnet Fingerprinting)
  When the C# Agent calls NetworkInterface.GetAllNetworkInterfaces(), Windows often returns adapters created by **Docker, Hyper-V, WSL, VMware, or VPNs** (like Tailscale or OpenVPN). These report virtual IP subnets (e.g., 172.17.x.x or 10.8.x.x) instead of the physical Ethernet/Wi-Fi adapter.
  If the Agent grabs a virtual adapter's subnet, the server will think two machines on the same physical office Wi-Fi are on different subnets and fail to select a relay.
  **The Fix in PowerRelay.cs:**
  Filter your interface enumeration to strictly target physical adapters:
  ```csharp
  var validInterface = NetworkInterface.GetAllNetworkInterfaces()
      .Where(ni => ni.OperationalStatus == OperationalStatus.Up)
      .Where(ni => ni.NetworkInterfaceType == NetworkInterfaceType.Ethernet || 
                   ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211)
      .Where(ni => !ni.Description.Contains("Virtual", StringComparison.OrdinalIgnoreCase) &&
                   !ni.Description.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase) &&
                   !ni.Description.Contains("WSL", StringComparison.OrdinalIgnoreCase) &&
                   !ni.Description.Contains("TAP", StringComparison.OrdinalIgnoreCase))
      .FirstOrDefault();
  ```
  ### 2. Windows Fast Startup & NIC Sleep States
  Modern Windows 10/11 devices enable "Fast Startup" by default, which puts the kernel into a hybrid hibernation state (S4/S5). Some network interface cards (NICs) disable their onboard WoL listener during hybrid shutdown unless explicitly configured in Device Manager.
  **The Fix:**
  Document in agent/[INSTALL.md](http://INSTALL.md) that for target PCs to wake consistently from full power-off, the target NIC must have **"Allow this device to wake the computer"** and **"Only allow a magic packet to wake the computer"** checked in Windows Device Manager.
  ## Summary Checklist
  | Component | Status | Strategy |
  |---|---|---|
  | **Relay Strategy** | Approved | Layer-2 peer broadcast over UDP 9 (3 bursts, 200ms apart) |
  | **Database** | Approved | power_commands table + JSONB devices.metadata.lan |
  | **Audit & Guardrails** | Approved | Rate-limited (3/min), staff-role restricted, 5s cancel toast |
  | **Delivery Slice** | Approved | Ship Wake + Power actions together in a single slice |
  How would you like to handle the UI when multiple online peer agents exist on the same subnet . display a peer selector to the admin?
  &nbsp;