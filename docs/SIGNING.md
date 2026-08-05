# Code signing (S25)

Every Windows binary ConnectLive distributes — the agent, both installers, and
the native admin console — is Authenticode-signed and RFC-3161 timestamped by
the build scripts. Without a signature Windows SmartScreen warns on every
install, Defender treats a remote-control agent as high risk, and Intune/GPO
deployments are rejected by hardened tenants.

## What you need

An **OV or EV code-signing certificate** from a public CA (DigiCert, Sectigo,
SSL.com, GlobalSign). Since June 2023 all new code-signing keys must live on
FIPS 140-2 hardware — a USB token, or the CA's cloud HSM. Practical
consequences:

| Certificate | Key location | Build machine |
| --- | --- | --- |
| OV via cloud HSM | CA's KSP/CSP, installed as a local cert | Any machine with the CA's signing client installed |
| OV/EV via USB token | Physical token | The token must be plugged into the machine running `build.ps1` |
| Internal/self-signed | `.pfx` on disk | Fine for lab and internal fleets only — public endpoints will still warn |

EV certificates get instant SmartScreen reputation. OV certificates build
reputation over time and installs may warn for the first few weeks.

## Configuring the build

Credentials are read from environment variables only — never committed, never
passed on the command line. Set one of the three, in this precedence order:

```powershell
# 1. Preferred: a cert already in CurrentUser\My (token, HSM, or imported).
$env:CODESIGN_THUMBPRINT = "A1B2C3...."      # SHA1 thumbprint, no spaces

# 2. A .pfx file on disk (lab / internal builds).
$env:CODESIGN_PFX          = "C:\certs\connectlive.pfx"
$env:CODESIGN_PFX_PASSWORD = "..."

# 3. Resolve by subject name from the local store.
$env:CODESIGN_SUBJECT = "ConnectLive Ltd"

# Optional: override the timestamp authority (default DigiCert).
$env:CODESIGN_TIMESTAMP_URL = "http://timestamp.sectigo.com"
```

Find a thumbprint:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Format-List Subject, Thumbprint, NotAfter
```

`signtool.exe` comes with the Windows 10/11 SDK ("Signing Tools for Desktop
Apps"). The helper locates it automatically under `Windows Kits\10\bin` — it
does not need to be on `PATH`.

## Building

```powershell
cd agent ; powershell -ExecutionPolicy Bypass -File build.ps1
cd ..\admin ; powershell -ExecutionPolicy Bypass -File build.ps1
```

Signing order matters and is already handled: `ConnectLive.exe` is signed
*before* the Inno and MSI packagers embed it, then the installers themselves
are signed *before* the distribution ZIP is created. Everything the endpoint
ever executes carries a signature.

Behaviour by configuration:

- **No `CODESIGN_*` set** — unsigned build plus a loud warning. Local
  development keeps working.
- **`CODESIGN_*` set** — a signing or verification failure aborts the build.
  A build that was asked to sign never ships unsigned.
- **`-SkipSign`** — explicit opt-out with no warning, for fast local loops.

Each artifact is verified with `signtool verify /pa /all` right after signing,
so a broken chain or missing timestamp fails at build time, not on a customer
machine.

## Verifying a shipped artifact

```powershell
signtool verify /pa /all /v dist\ConnectLiveSetup.exe
Get-AuthenticodeSignature dist\ConnectLiveAgent.msi | Format-List *
```

Look for `Status: Valid`, a `SignerCertificate` matching your CA, and a
`TimeStamperCertificate` — the last one is what keeps old releases valid after
the certificate expires.

## Release checklist tie-in

The SHA-256 hashes printed at the end of each build are computed *after*
signing, so the `public.releases` row you insert matches the signed bytes the
self-updater downloads. Never re-sign an artifact after publishing its hash —
the signature changes the file and the updater will reject it.
