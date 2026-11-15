# ConnectLive Agent — Inno installer

Use the main [build and startup guide](../../INSTALL.md). The installer carries
`ConnectLive.exe`, `ConnectLiveWatch.exe` and `ConnectLiveUpdate.exe`.
There is no capture service, automatic enrollment, or installer-created autorun.

After manual source testing on Windows, with .NET 8 SDK and Inno Setup 6:

```powershell
cd .\agent
.\build.ps1 -SkipMsi
```

The main build stages and signs all three files before Inno packages them, and
uses the same reviewed three-field version throughout. Do not compile against
stale `dist` files or invent a timestamp version.

Per-user installation defaults to the user's Programs folder. An all-users
installation requires normal administrator approval. Interactive installs can
open the pairing UI; silent installs do not launch/enroll a user.

After pairing, use **ConnectLive - enable Windows startup** from the Start menu
and confirm the disclosure. Startup is after that user's sign-in, not pre-login.
Both default and registered custom install paths are supported.

Removal runs local withdrawal. All-users removal also records a machine-wide
removal generation so signed-out users cannot silently reuse old approval after
reinstall. Normal local pairing is required again. Historical credentials are
not claimed to be physically erased from every profile or backup.

Use `Verify-Startup.ps1` and the Windows acceptance checklist in the main guide.
Inno compile/install/rollback behavior still needs a real Windows test.
