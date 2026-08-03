# Deploying ConnectLive Agent via Group Policy (GPO)

Silent, per-machine install for Active Directory domains. **No ADMX policy and
no deployment key** — the Agent enrolls itself keylessly on first run (see
`../../INSTALL.md`).

## One-time domain setup

Copy the built `agent/dist/ConnectLiveAgent.msi` to
`\\<domain>\NETLOGON\ConnectLive\ConnectLiveAgent.msi`.

## Per-OU policy

1. Group Policy Management → target OU → **Create a GPO** (e.g. "ConnectLive Rollout").
2. Edit the GPO: **Computer Configuration → Policies → Windows Settings → Scripts (Startup/Shutdown) → Startup** → add `install-gpo.ps1`.
3. Link the GPO to the OU. Devices install on next reboot; already-installed devices skip via ProductCode detection.

## Enrollment

First launch POSTs `/api/public/agent/enroll` with hostname/OS metadata only.
The server mints a per-device token, stored DPAPI-encrypted at
`%LOCALAPPDATA%\ConnectLive\device.dat`, and every later call authenticates with
`X-Device-Id` + `X-Device-Token`. There is nothing to distribute or rotate.

> Historical note: earlier builds shipped a `ConnectLive.admx`/`.adml` pair
> defining a **Deployment Key** policy that wrote
> `HKLM\Software\Policies\ConnectLive\DeploymentKey`. That mechanism was removed
> with the enrollment overhaul and the templates have been deleted. If those
> files are still in your PolicyDefinitions store or central store, remove them
> — the Agent never reads that value.
