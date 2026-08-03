# Which installer/build files to keep: repo vs. uploaded

I diffed the two uploaded files against what is in the project.

## build.ps1 — keep the repo version

The uploaded `build-2.ps1` is byte-identical to `agent/build.ps1` except that it
is **missing the last 22 lines**: the S14 release-manifest block that prints the
sha256 of each artifact and the `insert into public.releases` statement.

Self-update refuses a release row without a sha256, so that block is how you get
the hash. The repo copy is strictly newer. No change needed.

## ConnectLiveSetup.iss — keep the repo version, but port one idea over

The uploaded `ConnectLiveSetup-4.iss` is the **pre-overhaul** installer. Relative
to the repo copy it drops:

- the `[Tasks]` autostart opt-in checkbox
- the **HKCU Run** key and the **HKLM Run** key
- the **all-users Startup folder shortcut**
- `HKLM\Software\ConnectLive` **InstallPath / Version** metadata (self-update and
  support tooling read these)
- the pre-copy `taskkill /IM ConnectLive.exe` (without it a running agent can
  lock the exe and fail the file copy) and `CloseApplications=force`
- the uninstall cleanup of `{commonstartup}\ConnectLive.lnk`

So it has **one** logon trigger, not four. Shipping it would be a regression.

### The one thing the uploaded file does better

It registers the scheduled task from **generated XML via `schtasks /Create /XML`**
instead of the repo's inline `/TR` string. That is a legitimate concern: the repo
line nests escaped quotes around `"C:\Program Files\ConnectLive\ConnectLive.exe" /background`,
and that pattern is the classic way to end up with a task that registers fine and
then silently never launches.

`ConnectLiveAgentTask.xml` (the third upload) is the same definition as a
standalone template, with `__AGENT_EXE__` as a placeholder. Its `<URI>` is
`\ConnectLive` while the task name used everywhere else is `ConnectLiveAgent` —
that mismatch would need fixing if we adopt the file form.

Note also a bug in the uploaded `[Code]`: the comment says "Unicode=True" but the
call is `SaveStringToFile(XmlPath, Xml, False)` — that third argument is *append*,
not *Unicode*, so it writes an ANSI file whose declaration claims UTF-16.
`schtasks /XML` can reject that. Any port must fix it.

## Proposed change

Keep `agent/build.ps1` exactly as is. Make one surgical edit to
`agent/packaging/inno/ConnectLiveSetup.iss`:

1. Replace the inline `schtasks /Create /F /SC ONLOGON /TN "ConnectLiveAgent" /TR "..."`
   line in `[Run]` with an `AfterInstall: RegisterLogonTask` on the `[Files]`
   entry plus a `[Code]` procedure that builds the task XML with the real
   installed path baked into `<Command>`, writes it with the Unicode flag
   correctly set, and calls `schtasks /Create /F /TN "ConnectLiveAgent" /XML`.
2. Gate that registration on the `autostart` task so it still honours the
   checkbox, and log the schtasks exit code to `install.log`.
3. Add `{app}\ConnectLiveAgentTask.xml` to `[UninstallDelete]`.
4. Leave all four triggers, the HKLM metadata, the taskkill pre-step and the
   existing uninstall cleanup untouched.

Everything else — the other three triggers, HKLM/HKCU Run, Startup shortcut,
firewall rule, post-install launch — stays exactly as it is today.

## Docs to touch

- `agent/packaging/inno/README.md` — note the task is now registered from
  generated XML.
- `PROJECT-MAP.md` — one line in the installer section recording the change.

After the edit I re-cut `ConnectLive-Agent-source-<date>.zip` so the zip carries
the fixed installer.
