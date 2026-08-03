# Deploying ConnectLive Agent via Jamf Pro (Windows)

Silent MSI install. **No deployment key, no configuration profile** — the Agent
enrolls itself keylessly on first run (see `../../INSTALL.md`).

## Upload

1. Build the MSI (`../msi/build-msi.ps1`).
2. Jamf Pro → **Computer Management → Packages → New** → upload `ConnectLiveAgent.msi`.
3. Create a Policy:
   - **General → Trigger:** Enrollment Complete + Recurring Check-In.
   - **General → Frequency:** Once per computer.
   - **Packages:** add the MSI, action = Install.
   - **Scope:** Smart Group of Windows 10/11 x64 devices without ConnectLive present.

That is the whole rollout. There is nothing to rotate and nothing to scope
alongside the package.

## Enrollment

On first launch the Agent POSTs `/api/public/agent/enroll` with hostname/OS
metadata only. The server mints a random per-device token and the Agent stores
it DPAPI-encrypted at `%LOCALAPPDATA%\ConnectLive\device.dat`; every later call
authenticates with `X-Device-Id` + `X-Device-Token`.

Enrollments are rate-limited per source IP, and a fresh device row is inert
until a super-admin creates a session against it — so an accidental rollout
costs nothing but a few rows to delete.

> Historical note: earlier builds read a deployment key from
> `HKLM\Software\Policies\ConnectLive\DeploymentKey` pushed by a Jamf
> Configuration Profile. That mechanism was removed with the enrollment
> overhaul; the Agent no longer reads that value. If you still have the profile
> scoped, unscope it — it does nothing.
