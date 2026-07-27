# Deploying ConnectLive Agent via Microsoft Intune

Silent, per-machine, SYSTEM-context enrollment. No end-user interaction.

## Prereqs

- Built MSI at `agent/dist/ConnectLiveAgent.msi` (run `../msi/build-msi.ps1`).
- `IntuneWinAppUtil.exe` from Microsoft's [Win32 Content Prep Tool](https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool).
- A deployment key (issued in the ConnectLive admin panel; rotate any time without repackaging).

## Wrap

```powershell
./wrap-intune.ps1 -IntuneWinAppUtil C:\Tools\IntuneWinAppUtil.exe
```

Produces `agent/dist/ConnectLiveAgent.intunewin`.

## Upload

1. Intune admin center → **Apps → Windows → Add → Win32 app**.
2. Upload `ConnectLiveAgent.intunewin`.
3. Copy the fields from `intune-app.json`. Critically:
   - **Install command** — replace `REPLACE_WITH_YOUR_KEY` with the actual deployment key.
   - **Install behavior** — System.
   - **Detection rules** — MSI product code (already in `intune-app.json`).
4. **Assignments** → target the device groups you want auto-enrolled.

## Rotating the key later

You do **not** have to re-wrap the MSI. Either:

- **Recommended:** push the new key via a Configuration Profile → Registry setting to `HKLM\Software\Policies\ConnectLive\DeploymentKey`. `DeploymentKey.Resolve()` reads that first.
- Or update the Install command and redeploy the app.
