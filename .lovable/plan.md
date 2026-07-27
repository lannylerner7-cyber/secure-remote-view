## Goal

Ship two guardrails in `admin/` + `agent/`, then add MDM packaging so ConnectLive can be silently deployed via Intune, Jamf-style (Windows via Jamf Pro), or GPO.

## 1. WebRTC guardrails (admin + agent)

### 1a. D3DImage STA marshaling (admin)

`admin/src/Media/WebRtcClient.cs` currently only scaffolds the video track. When we wire a real Media Foundation / SIPSorcery H.264 decoder, the "sample ready" event will fire on a worker thread. Route every frame update through the WPF dispatcher:

- Add a `D3DImageHost` helper that owns the `D3DImage` and exposes `PushFrame(IntPtr surface, int w, int h)`.
- Inside `PushFrame`, wrap the Lock / SetBackBuffer / AddDirtyRect / Unlock sequence in `Application.Current.Dispatcher.InvokeAsync(...)`.
- Wire `WebRtcClient.OnVideoFrame` → `D3DImageHost.PushFrame`. Fall back to `Dispatcher.BeginInvoke` when the dispatcher is shutting down (session close race).
- Bind the `D3DImage` to the existing `FrameImage` control in `LiveSessionWindow.xaml` behind a `ClientOnly`-style toggle so the JPEG fallback still works when WebRTC never connects.

### 1b. H.264 profile pinning (agent + admin)

Both sides must advertise the same profile so the admin's decoder does not black-screen.

- `agent/src/WebRtcSession.cs`: replace the current default SDP with a `MediaStreamTrack` that lists exactly one H.264 format:
`profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1` (Constrained Baseline 3.1).
- `admin/src/Media/WebRtcClient.cs`: mirror the same format string when adding the recv-only video track (already `packetization-mode=1`, add `profile-level-id=42e01f` and `level-asymmetry-allowed=1`).
- Drop any other H.264 payload types from the offer/answer so SIPSorcery cannot renegotiate to a mismatched profile.

## 2. MDM / silent-enrollment packaging

Goal: a workspace admin drops one file into Intune / a GPO / a Jamf Pro Windows policy and every endpoint auto-enrolls with a shared deployment key. No end-user interaction, no UAC prompts after install.

### 2a. Deployment-key provisioning contract

Reuse the existing `DeploymentKey.Resolve()` order (`%ProgramData%\ConnectLive\deployment.key` → env → embedded). MDM packages MUST write the key to the file path, never bake it into the MSI, so ops can rotate without repackaging:

- Installer accepts `DEPLOYMENT_KEY="..."` as an MSI property.
- On install, the CustomAction writes it to `%ProgramData%\ConnectLive\deployment.key` with ACL = `SYSTEM:F, Administrators:F` (no `Users` read). Documented in `agent/INSTALL.md`.

### 2b. MSI build

Add `agent/packaging/msi/`:

- `ConnectLive.wxs` (WiX v4) that installs:
  - `%ProgramFiles%\ConnectLive\ConnectLiveAgent.exe`
  - `%ProgramFiles%\ConnectLive\ConnectLiveWatcher.exe`
  - Registers the Watcher as a Windows Service under `LocalSystem`, `Start=Auto`, `DelayedAutostart=1`.
  - Adds firewall rule for outbound 443 (no inbound).
  - Writes the deployment key via a `Type 1` CustomAction reading the `DEPLOYMENT_KEY` property.
- `build-msi.ps1` that calls `dotnet publish -c Release -r win-x64 --self-contained` for both projects, then `wix build ConnectLive.wxs`.
- Output: `agent/dist/ConnectLiveAgent.msi` (per-machine, silent-capable: `msiexec /i ConnectLiveAgent.msi /qn DEPLOYMENT_KEY=xxxxx`).

### 2c. Intune (.intunewin)

Add `agent/packaging/intune/`:

- `wrap-intune.ps1` that runs Microsoft's `IntuneWinAppUtil.exe` (documented download, not vendored) against the built MSI and emits `ConnectLiveAgent.intunewin`.
- `intune-app.json` — Intune Win32 app metadata template (install command, uninstall command, detection rule via MSI ProductCode, requirements 64-bit Windows 10+, run context = System).
- `README.md` with step-by-step "upload to Intune, set DEPLOYMENT_KEY in install command" instructions.

### 2d. GPO (ADMX + startup script)

Add `agent/packaging/gpo/`:

- `ConnectLive.admx` + `en-US/ConnectLive.adml` exposing one policy: `DeploymentKey` (string) under `Computer Configuration → Policies → Administrative Templates → ConnectLive`. Value writes to `HKLM\Software\Policies\ConnectLive\DeploymentKey`.
- Update `DeploymentKey.Resolve()` to check that registry key before the file path (new step 0). Documented in the ADMX and `agent/INSTALL.md`.
- `install-gpo.ps1` startup script that runs `msiexec /i \\domain\netlogon\ConnectLive\ConnectLiveAgent.msi /qn` if the ProductCode is not already installed.
- `README.md` for the "copy MSI to NETLOGON, import ADMX, link startup script" flow.

### 2e. Jamf Pro (Windows)

Add `agent/packaging/jamf/`:

- Since Jamf Pro for Windows deploys MSIs directly, ship a `jamf-package-manifest.json` that describes the MSI, install command, and a `configuration-profile.xml` that pushes the deployment key via Jamf's Windows Configuration Profile → Registry payload writing `HKLM\Software\Policies\ConnectLive\DeploymentKey`.
- `README.md` covering upload + smart-group targeting.

(macOS Jamf is out of scope — the agent is Windows-only.)

## 3. Docs

- `agent/INSTALL.md`: new "Enterprise deployment" section pointing at each `packaging/*/README.md`.
- `admin/INSTALL.md`: note the H.264 profile requirement so future forks don't drift.
- No home-page changes; MDM is B2B and lives in docs.

## Technical notes / non-goals

- No IddCp phantom-monitor driver, no forced 4K/120Hz mode enumeration, no HDR passthrough — you picked "Guardrails + MDM" only. I'll leave `agent/src/DxgiCapture.cs` where it is.
- No signing pipeline in this pass — MSI is unsigned; docs will call out that customers should re-sign with their own EV cert before wide rollout. If you want us to add a signing step (SignTool + timestamp), say so and I'll fold it in.
- No new server routes. Enrollment still goes through the existing `/api/public/agent/enroll` with `X-Deployment-Key`.
- No changes to `/connectlive/admin`, `/console`, payments, or any web route.

## Deliverables

- Updated `admin/src/Media/WebRtcClient.cs` + new `admin/src/Media/D3DImageHost.cs`.
- Updated `agent/src/WebRtcSession.cs` (H.264 profile pinned).
- Updated `agent/src/DeploymentKey.cs` (registry check).
- New `agent/packaging/{msi,intune,gpo,jamf}/` trees with build scripts and READMEs.
- Repackaged `public/ConnectLiveAgent.zip` including MSI + intunewin + ADMX artifacts.
- Doc updates in `agent/INSTALL.md` and `admin/INSTALL.md`.
- &nbsp;
  ### Implementation Detail to Watch
   * **WiX v4 CustomAction Execution Context:** When the WiX MSI executes the CustomAction that writes DEPLOYMENT_KEY to %ProgramData%\ConnectLive\deployment.key during a silent /qn install, ensure the CustomAction is marked with:
     * Execute="deferred"
     * Impersonate="no"
     If Impersonate="yes" (the default), silent deployments pushed via Intune/GPO running in elevated context might attempt to write the file under a temporary user profile context rather than LocalSystem, leading to missing key errors on boot.
  ## 3. Scope & Deliverables Checklist
  | Module | Strategy | Security / Mechanics |
  |---|---|---|
  | **Admin UI** | D3DImageHost + WPF Dispatcher | Non-blocking frame drops; fallback to JPEG mode |
  | **Agent Core** | Hardcoded Baseline 3.1 SDP | Prevents codec mismatch & hardware decode failure |
  | **WiX MSI** | Per-machine installer | Watcher registered as LocalSystem with DelayedAutostart |
  | **GPO / ADMX** | HKLM Policy Registry key | Step 0 override in DeploymentKey.Resolve() |
  | **Intune / Jamf** | Silent MSI + Config Profiles | Standard /qn execution via SYSTEM context |
  You have effectively eliminated all the common failure modes of enterprise agent deployments (UAC prompts, profile desyncs, thread crashes, and unmanageable key rotation).
  Are you planning to compile the WiX v4 project directly via the dotnet wix CLI toolset inside build-msi.ps1, or will you be running the standalone WiX binaries? let just have both agent admin zip first we will desice later  once set as plan
  &nbsp;