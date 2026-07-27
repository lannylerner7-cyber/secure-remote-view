# Deploying ConnectLive Agent via Group Policy (GPO)

Silent, per-machine install for Active Directory domains.

## One-time domain setup

1. Copy `ConnectLive.admx` to `%SystemRoot%\PolicyDefinitions\` on your domain controller (or to the central store `\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\` for domain-wide replication).
2. Copy `en-US/ConnectLive.adml` to the matching `en-US` subfolder.
3. Copy the built `agent/dist/ConnectLiveAgent.msi` to `\\<domain>\NETLOGON\ConnectLive\ConnectLiveAgent.msi`.

## Per-OU policy

1. Group Policy Management → target OU → **Create a GPO** (e.g. "ConnectLive Rollout").
2. Edit the GPO:
   - **Computer Configuration → Policies → Administrative Templates → ConnectLive → Deployment Key** → enter the current deployment key. This writes `HKLM\Software\Policies\ConnectLive\DeploymentKey`, which the agent reads first.
   - **Computer Configuration → Policies → Windows Settings → Scripts (Startup/Shutdown) → Startup** → add `install-gpo.ps1`.
3. Link the GPO to the OU. Devices install on next reboot; already-installed devices skip via ProductCode detection.

## Rotating the key

Change the ADMX policy value only — no reinstall required. Every device picks up the new key on next Group Policy refresh. Already-enrolled devices are unaffected because they authenticate with their own per-device tokens after first enrollment.
