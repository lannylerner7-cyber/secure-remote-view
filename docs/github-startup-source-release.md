# GitHub delivery — Windows startup, installer scripts and session tools

Date: 2026-11-15. This is a **source delivery**, not a Windows binary release.

Repository: https://github.com/lannylerner7-cyber/secure-remote-view

Target: `main`, through a normal, non-force push on top of
`7cdcc4947551d9f1873cfbe1f756ddaf8ee3a92e`.
This report is committed with the update; find that commit with:

```sh
git log -1 --format=%H -- docs/github-startup-source-release.md
```

## Included

- Complete current Windows Agent source, including the already-merged session
  tools and their browser/server counterparts.
- Explicit owner startup approval, custom install path recognition, visible
  limited-user Watch logon/recovery, and installation-lifetime withdrawal.
- Updated `agent/build.ps1`, MSI inspection helper, MSI wrapper, installer
  definitions and installation documentation.
- Read-only `agent/Verify-Startup.ps1`; it never contacts the backend, changes
  startup settings, launches/kills processes or exports credential files.
- Required WiX tooling manifest, shared source and signing helper.
- The session-tools SQL migration as **unapplied source**, not a database change.

The Agent source version remains `1.10.14`; identify this revision by its Git
commit and the source archive's manifest, not by the version alone.

## Verification on the exact GitHub-layout export

| Check | Result |
| --- | --- |
| Unmodified fetched upstream | Clean-cache frozen dependency install, TypeScript check and build passed before applying the update. |
| Updated dependency lock | Frozen install passed; only `@noble/hashes` and its matching lock entry were added for the merged file-integrity code. Existing upstream dependency versions were retained. |
| Updated web application | TypeScript check and production Node-server build passed with synthetic public configuration and no application secrets. |
| Built server smoke checks | `/health`, `/` and `/connectlive/admin` each returned HTTP 200. No real session or account was used. |
| PowerShell | 32 parser/MSI-table validator checks passed. MSI tables were synthetic; Windows Installer COM and signing were not executed. |
| Portable startup source | 30 assertions passed; linked production startup/setup/grant/lifecycle code compiled with inert platform adapters. |
| Portable session-tools source | 42 assertions passed; no Windows client executable was built. |
| HTTP/session-tool/preview regressions | 128 tests passed, none failed or skipped. Identity, outages, permissions, transfer integrity, microphone receipts and preview-only timeout behavior were exercised in isolation. |
| Installer/UI contracts | Passed; static checks only. |
| Source dependency closure | All 157 Agent/shared/tool source files were inventoried; explicit first-party project references and required scripts were present. |
| Public dependency URLs | 82 explicit lockfile URLs passed the credential-free public HTTPS check. |
| Release scope | Explicit file allowlist, whitespace and credential-pattern checks passed. These are not a full security scan. |

Unrelated upstream source was preserved, including checkout/payment code,
existing database migrations, native Admin source, upstream-only homepage
metadata and build dependency versions. The only new database file is the
unapplied session-tools migration.

## Windows: run these stages separately

Extract the **whole source archive into a new folder**. Keep the sibling
`agent`, `tools` and shared dependency folders intact. Use an authorized Windows
x64 test PC with the .NET 8 SDK and a person at its keyboard.

### 1. Source test — no MSI

From the extracted root:

```powershell
cd .\agent
.\run.ps1 -Pair
```

The script builds the actual Agent and both companions on your Windows PC.
It does not download a prebuilt Agent or create an installer. If an old Agent
is running, the script stops with instructions; it does not silently kill it.
`-Pair` requests a new authorized pairing. Omit it to retain a valid pairing
against the same server. A confirmed support-session end requires a new code.

### 2. Only after the manual source test passes — MSI

From `agent`, run:

```powershell
.\build.ps1 -SkipInno
```

This **does build an MSI**. The script restores pinned WiX, publishes all three
runtime executables, checks the compiled MSI, uses configured signing, and
writes `dist\MSI-VERIFICATION.json`. Missing signing configuration is explicitly
reported as unsigned; an unsigned test installer is not a signed public release.

### 3. After installation, pairing and local startup approval

Use **ConnectLive - enable Windows startup** in the Start menu. Then run as the
same Windows user who paired:

```powershell
.\Verify-Startup.ps1 -RequireReady -OutputPath .\startup-before.json
```

Reboot the test PC yourself, sign into that Windows account, then run:

```powershell
.\Verify-Startup.ps1 -RequireReady -OutputPath .\startup-after.json
```

For a custom path, add `-InstallDirectory "C:\Apps\ConnectLive"`. Follow the
full acceptance checklist in `agent/INSTALL.md`, including standard-user and
signed-out-profile removal/reinstall, upgrade, rollback, revocation, Task Manager,
real capture/video and session tools.

## What is not certified

- **Full Windows compilation, MSI creation/installation, signing, reboot,
  Task Scheduler/registry/ACL behavior and hardware sessions remain unverified.**
  Passing parser, synthetic and portable tests cannot establish those results.
- Startup is after the paired user's Windows sign-in, not before login. Closing
  a process is not revocation; separately approved recovery may restart it only
  after fresh authorization. Revoked permission must not be restored by recovery.
- The session-tools migration
  `supabase/migrations/20261115000000_session_tools.sql` has **not been applied
  to the shared database**. New transfer-reservation/enrollment operations fail
  explicitly until its target is separately reviewed and approved. A Git push
  does not itself apply that migration.
- No Windows executable, MSI, installer ZIP, automatic update or customer-device
  operation was produced or performed here. A source ZIP contains source only.
- No deployment was manually triggered. Existing GitHub/Coolify automation may
  react to the push; a successful push is not production deployment evidence.
- The initial startup/session-tools reports describe the checks before this
  source delivery. Their historical “not pushed” wording is not a remote branch
  status check.
