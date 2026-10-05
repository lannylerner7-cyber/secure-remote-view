# Android agent: close the gaps before writing the APK

I checked the roadmap against the live backend line by line. Three things in
the roadmap do not match reality, and two things the Android agent needs
(install tracking and updates) do not exist yet. Fixing these first is what
stops the Windows and Android sides getting tangled once the APK exists.

## What the check found

**1. There is no reliable way to tell Windows from Android.**
The roadmap says we tell platforms apart using the device's `os` field. In the
real database that field holds free text like
`Microsoft Windows NT 10.0.26200.0` — it is a version string the agent reports,
not a platform label. Android phones would report something equally free-form.
Branching on it would be guesswork, which is exactly the "twisted wires"
problem.

**2. The remote-command list has no Android entries.**
The database only accepts these commands: wake, wake agent, reboot, shutdown,
lock, log off, restart stream, restart agent, switch monitor. The roadmap
invented names ("restart", "restart_app") that the database would reject, and
nothing stops a technician sending "wake over the network" or "switch monitor"
to a phone, where neither exists.

**3. Updates cannot be published for Android.**
The release list only accepts two product types: agent (Windows) and admin.
An Android APK release cannot be recorded at all, so the phone would have
nothing to check for updates against.

**4. "Is it installed?" only works for Windows.**
The Expected Devices list matches by computer name. Phones do not have a
computer name a technician would know in advance, so Android devices would
always read as "not installed".

**5. Admins cannot see which version each device is running.**
The version is stored but never shown, so there is no way to spot a phone or
PC stuck on an old build.

## The plan

### Step 1 — Give every device a real platform label
Add a dedicated platform field to each device, set once at sign-up, holding
exactly `windows` or `android`. Existing devices are labelled `windows`. The
free-text OS text stays as-is for display. Every platform-specific decision
reads this field and nothing else.

### Step 2 — Make commands platform-aware
Add the Android commands the phone can actually perform (reboot device,
restart app, restart stream, lock) and have the server reject any command the
target platform cannot do, with a clear "not supported on this device"
response. The console hides unsupported buttons instead of showing ones that
will fail: no Wake-on-LAN, no shutdown, no monitor switching on a phone.

### Step 3 — Android release channel + in-app updater
Allow `android` as a release product so an APK can be published on the stable
or beta channel. The phone checks the same release endpoint, compares versions,
and either prompts the user to install the new APK or installs it silently when
the device is enrolled as a company-managed device. The console gets a simple
publish form and the agent records which version it is running on every
check-in.

### Step 4 — Install tracking that works for phones
Replace computer-name-only matching with an enrollment-code approach for
Android: the technician generates a short pairing entry for a named phone
("Warehouse iPad 3"), the phone claims it during setup, and the Expected
Devices list flips to "installed" the moment it does. Windows keeps its
existing computer-name matching unchanged. Both appear in one list with a
platform badge and a last-seen time.

### Step 5 — Version + install visibility in the console
Show platform, running version, and "update available" on every device row,
with a filter for devices behind the latest release.

### Step 6 — Then build the APK
Only after 1–5 are live do we scaffold `android-agent/` and work through the
roadmap's build order: enrollment and heartbeat, WebRTC data channel, screen
capture and hardware video, touch injection, curtain overlay, remote restart.

## Technical notes

- New column `devices.platform text not null default 'windows'` with a check
  constraint on `('windows','android')`; backfilled from the existing rows;
  set from a new `platform` field on the enroll request body.
- `power_commands_kind_check` extended with `restart_app`; a server-side
  allow-list per platform rejects mismatches with HTTP 409
  `unsupported_for_platform`. Windows allow-list is unchanged so nothing
  regresses.
- `releases_product_check` extended with `android`; `PRODUCTS` set in
  `src/routes/api/public/agent/release.ts` extended to match.
- `expected_devices` gains a nullable `claim_code` plus `platform`; a new
  public claim step on the enroll route binds the phone to its roster row.
  Hostname matching stays the fallback for Windows.
- Heartbeat writes `metadata.agent_version` (already supported) — the console
  reads it and compares with the newest published release for that product.
- `roadmap.md` §4.1, §4.3 and §4.5 are rewritten to reflect the real column
  names and command list once the migration lands.
