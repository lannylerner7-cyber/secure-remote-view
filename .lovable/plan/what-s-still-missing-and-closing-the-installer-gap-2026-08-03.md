# What's still missing — and closing the installer gap

Two things in this plan: an honest list of what the project still lacks (with the reason each one is still open), and a concrete rewrite of the Inno installer so every autostart path is created at install time instead of relying on the agent to self-heal them.

## Part 1 — What we still lack, and why

Ordered by how much each one blocks everything else.

### 1. No Windows build has shipped to the fleet (S3) — the root blocker

The only online device reports `lan` in its metadata but no `monitors[]` and no `encoder{}`. That means the last several features — monitor picker, bitrate ladder, hardware-encoder probe, predictive cursor — have **zero production evidence**. They are written and typecheck, but nothing in the field has ever run them.

Why it's still open: the build is a Windows-only toolchain (`dotnet publish` + Inno + WiX). It cannot be produced or executed from this environment. Someone has to run `agent/build.ps1` on a Windows box.

### 2. No TURN server deployed (S9, half-open)

`/api/public/agent/ice` exists and all three peers consume it, but `TURN_URLS` / `TURN_STATIC_SECRET` are unset, so the response is STUN-only. Symmetric NAT and corporate egress filtering will silently degrade those sessions to the JPEG fallback — exactly the lag the video engine was built to escape.

Why it's still open: it needs a TURN relay host, not code. Google does **not** offer a public TURN service; `stun.l.google.com` is STUN-only. A TURN relay must be either a self-hosted coturn VM or a paid managed TURN provider.

**Cloudflare Calls TURN is the cleanest fit.** It gives you a global anycast relay network and mints per-session credentials through the Cloudflare API, so `/api/public/agent/ice` can return fresh `username`/`credential` pairs for every peer without a static secret in the agent. Pricing is metered by data relayed.

### 3. Soak proves the wire, not the picture (S8, half-open)

`scripts/e2e-soak.ts` measures enrollment/heartbeat/frame/cursor latency through Realtime and gates on error rate. It does not measure the native render half: sustained-motion fps, working set growth, decode errors, tearing, colour drift, or a forced mid-run `switch_monitor`.

Why it's still open: that half needs a real Windows agent and the native console running for ten minutes — blocked on item 1.

### 4. Nothing is code-signed

`build.ps1` prints the `signtool` command as advice. Unsigned, SmartScreen will warn on every install, and a self-update that swaps an unsigned binary is a hard sell to any IT department.

Why it's still open: requires purchasing an EV/OV code-signing certificate.

### 5. No releases rows published (S14 ops tail)

Self-update is implemented and verifies SHA-256, but `public.releases` is empty, so no agent will ever update itself. Blocked on item 1 producing an artifact and somewhere to host it.

### 6. Two stale contracts (S15b)

Documentation-level drift only: leftover references that no longer match shipping behaviour. Small, safe to clean any time.

### 7. Admin console distribution

`admin/build.ps1` produces the console but there is no signed, versioned, zipped admin package equivalent to the agent's MSI/Inno pair, and no self-update path for the admin at all.

**The honest summary:** the code layer is largely complete. Everything remaining is packaging, infrastructure, and field evidence — and all three converge on getting one signed Windows build onto one real machine.

## Part 2 — Installer rewrite (`agent/packaging/inno/ConnectLiveSetup.iss`)

Today the .iss creates exactly one autostart trigger (the ONLOGON scheduled task) and leaves the HKCU Run key and Startup shortcut to `StartupSelfHeal` at first launch. That means between install and first launch there is a window with a single point of failure, and a silent/GPO install that never sees an interactive launch gets one trigger only.

Changes:

**Add all four autostart triggers at install time, all with identical argv (`/background`):**

1. `[Registry]` — `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `ConnectLive`, data `"{app}\ConnectLive.exe" /background`, with `uninsdeletevalue`. Written under the invoking user's hive.
2. `[Registry]` — `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`, same value/data, `uninsdeletevalue`. Machine-wide fallback so a fresh user profile on the same box still starts the agent.
3. `[Icons]` — a `.lnk` in `{commonstartup}` (all-users Startup folder) pointing at the exe with `/background` and `Comment` set, so an admin can eyeball it in `shell:common startup`.
4. `[Run]` — keep the existing per-machine ONLOGON scheduled task, but harden it: add `/RU "%USERNAME%"` semantics via ONLOGON's implicit per-user trigger, keep `/RL LIMITED` and `/DELAY 0000:10`, and add `/IT` so it only fires for interactive sessions (the agent needs a desktop for capture and consent).

**Also:**

- Add a `[Tasks]` checkbox (`autostart`, checked by default, `Flags: checkedonce`) so an interactive installer can opt out; all four triggers get `Tasks: autostart`. Silent installs get it by default.
- Add a `[Registry]` entry recording the installed version and install path under `HKLM\Software\ConnectLive` so self-update and support tooling can read them without probing the filesystem.
- Extend `[UninstallRun]`/`[UninstallDelete]` to remove all four triggers — currently only the scheduled task and firewall rule are cleaned up, so an uninstall today leaves Run keys and a Startup shortcut behind pointing at a deleted exe.
- Add `CloseApplications=force` plus a `taskkill` in a `[Run]` pre-step so an in-place upgrade over a running agent doesn't fail on a locked exe. Pair with `RestartApplications=no` (already set) since the triggers relaunch it.
- Keep the post-install launch line exactly as-is (`shellexec runasoriginaluser`) — that combination is load-bearing and must not be simplified.

**Mirror the same triggers into `agent/packaging/msi/ConnectLive.wxs**` so MSI and Inno installs produce byte-identical autostart state. Right now they can diverge, which makes field diagnosis guesswork.

**Doc updates:** `agent/INSTALL.md` and `agent/packaging/inno/README.md` get a short "autostart triggers" table listing all four, where to look for each, and how to verify them (`schtasks /Query /TN ConnectLiveAgent`, `reg query`, `shell:common startup`). `PROJECT-MAP.md` §8 gets the packaging row updated.

## Technical notes

- All four triggers must pass the identical lowercase `/background` flag. `App.xaml.cs` branches on it to suppress the splash; a casing mismatch produces a visible window on boot and breaks the audit trail.
- `StartupSelfHeal` stays exactly as-is. It becomes belt-and-braces rather than the primary mechanism — it re-asserts the HKCU key if Group Policy strips it.
- The HKLM Run key runs for *every* user who logs into the box. That is intended for a shared/kiosk machine, and each session enrolls against the same DPAPI-sealed `device.dat` under `%LOCALAPPDATA%`, so a second user will enroll as a second device. Worth confirming this is the behaviour you want before I ship the HKLM key — say the word and I'll drop trigger 2 and rely on the scheduled task for the multi-user case.
- No changes to the agent C# source in this plan; it is packaging and docs only.

## Cloudflare Calls TURN — what you need and how we'd wire it

**What you need from Cloudflare:**

1. A Cloudflare account.
2. The **Calls** product enabled in the Cloudflare dashboard.
3. A Calls app — this gives you an **App ID** and an **App Token** (the token is the secret; the ID is not secret).

**What the code change looks like:**

- Add `CLOUDFLARE_CALLS_APP_ID` and `CLOUDFLARE_CALLS_APP_TOKEN` as runtime secrets.
- In `/api/public/agent/ice`, when those secrets are present, call Cloudflare's TURN credentials endpoint (`POST https://rtc.live.cloudflare.com/v1/turn/keys/{app_id}/credentials/generate`) with a short-lived expiry (e.g. 24 hours).
- Return the Cloudflare TURN URLs + the minted username/credential in the `iceServers` array, alongside the existing STUN set.
- Keep the coturn branch as a fallback so you can switch providers without a code deploy.

**Why this is better than a static secret:**

- Each agent and each admin console gets its own short-lived credential.
- No long-lived TURN password lives in the agent binary or env.
- Cloudflare's relay is anycast, so latency is usually lower than a single self-hosted VM.

**What you pay:** Cloudflare Calls bills for relayed data; STUN is free. For a helpdesk tool this is typically small per active session.

**Setup steps (you do this once in Cloudflare):**

1. Go to **Cloudflare dashboard → Calls** (or search "Calls").
2. Create a new Calls app.
3. Copy the **App ID** and create an **App Token**.
4. Paste both into the secure form when I request them.

Then I update `/api/public/agent/ice` and `.env.sample` in the same turn.

## Not in this plan

Code signing, publishing `releases` rows, and the Windows build itself — those are infrastructure/ops actions that need to happen on your side, not code changes I can make here.