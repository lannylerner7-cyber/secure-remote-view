# ConnectLive — Release Checklist (Windows)

Single procedure for turning the source zips into signed, published builds.
The web app and backend ship from Lovable; only the Agent and the Admin
Console are built here.

## 0. Prerequisites (install once)

- **.NET 8 SDK** — <https://dotnet.microsoft.com/download/dotnet/8.0>
- **Inno Setup 6** (agent installer) — `iscc.exe` on `PATH`
- **WiX v4** (agent MSI):
  ```powershell
  dotnet tool install --global wix
  wix extension add -g WixToolset.Util.wixext
  wix extension add -g WixToolset.Firewall.wixext
  ```
- Optional: code-signing certificate + `signtool.exe` (Windows SDK)

## 1. Build

```powershell
# Agent  -> agent\dist\ConnectLive.exe, ConnectLiveSetup.exe, ConnectLiveAgent.msi
cd agent
./build.ps1                 # add -SkipInno / -Version 1.0.YYYYMMDD.HHmm as needed

# Admin  -> admin\dist\ConnectLiveAdmin.exe + ConnectLiveAdmin.zip
cd ..\admin
./build.ps1
```

One-shot alternative for plain exes + zips: `build.bat` at the repo root.

## 2. Sign (recommended)

```powershell
signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 `
  agent\dist\ConnectLive.exe agent\dist\ConnectLiveSetup.exe `
  agent\dist\ConnectLiveAgent.msi admin\dist\ConnectLiveAdmin.exe
```

Sign **before** hashing — signing changes the file.

## 3. Capture checksums

```powershell
Get-FileHash -Algorithm SHA256 agent\dist\ConnectLiveSetup.exe
Get-FileHash -Algorithm SHA256 admin\dist\ConnectLiveAdmin.zip
```

Both build scripts already print this block at the end.

## 4. Upload + publish the release rows

`/api/public/agent/release` (S14) serves the newest `published = true` row per
`product` + `channel`; the agent's `SelfUpdate` verifies the sha256 before
swapping binaries, so a wrong hash means no update, not a bad update.

```sql
insert into public.releases
  (product, channel, version, download_url, sha256, notes, mandatory, published, published_at)
values
  ('agent', 'stable', '<version>', '<download-url>', '<sha256>', '<notes>', false, true, now());

insert into public.releases
  (product, channel, version, download_url, sha256, notes, mandatory, published, published_at)
values
  ('admin', 'stable', '<version>', '<download-url>', '<sha256>', '<notes>', false, true, now());
```

## 5. Post-publish verification

```bash
BASE=https://connectliveagent.com bun run scripts/verify-agent-routes.ts   # expect 22/22
bun run scripts/verify-payment-routes.ts                            # expect 5/5
```

Then, on one pilot machine:

1. Install silently: `ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES`
2. Confirm all four autostart triggers exist — HKCU Run, HKLM Run,
   `shell:common startup\ConnectLive.lnk`, scheduled task `ConnectLiveAgent`
   — each with the lowercase `/background` argument.
3. Reboot, log in, confirm the device appears online in the console within
   ~30 s and that a live session connects (check the transport pill reads
   "Native video").
4. Uninstall and confirm the task, shortcut, Run keys, and firewall rule are
   all removed.

## 6. Open items this unblocks

- **S3** — Windows fleet rollout (needs a Windows host).
- **S8 residual** — native-render soak: sustained motion, working set, decode
  errors, forced mid-session `switch_monitor`. Pass criteria come from S11
  telemetry; record the result in `PROJECT-MAP.md` §8.
