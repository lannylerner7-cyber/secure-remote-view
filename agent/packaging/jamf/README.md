# Deploying ConnectLive Agent via Jamf Pro (Windows)

Silent MSI + Configuration Profile for the deployment key.

## Upload

1. Build the MSI (`../msi/build-msi.ps1`).
2. Jamf Pro → **Computer Management → Packages → New** → upload `ConnectLiveAgent.msi`.
3. Create a Policy:
   - **General → Trigger:** Enrollment Complete + Recurring Check-In.
   - **General → Frequency:** Once per computer.
   - **Packages:** add the MSI, action = Install.
   - **Scope:** Smart Group of Windows 10/11 x64 devices without ConnectLive present.

## Deployment key

1. **Configuration Profiles → Upload** → `configuration-profile.xml`.
2. Edit the profile and replace `REPLACE_WITH_YOUR_KEY` with the current deployment key.
3. Scope the profile to the same Smart Group.

The profile writes `HKLM\Software\Policies\ConnectLive\DeploymentKey`, which `DeploymentKey.Resolve()` reads first. Rotate the key by editing this one profile — no MSI rebuild required.
