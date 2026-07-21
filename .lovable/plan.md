## Curtain Mode (Block Local Input) — plan

Add commercial-grade "pause user" to ConnectLive: while the admin holds control, the local keyboard/mouse are disabled, a maintenance overlay covers the screen for the physical user, and the admin's captured stream stays clean. Built on top of the existing standing-consent + banner model — no bypass of consent, no hidden capture.

&nbsp;

​This is a physical impossibility under your current design. BlockInput(true) disables hardware interrupts at the OS driver level. The local user's physical mouse will not move the cursor, and their physical keyboard will not register clicks. Therefore, **the local user cannot drag the banner or click the "End" button.**

- ​**The Fix:** Update your overlay copy to explicitly tell the user *how* to regain control. Change the text to: *"Your IT administrator is performing maintenance. Input is temporarily disabled. **Press Ctrl+Alt+Del to override and regain control.***"

### ​2. Topmost Z-Order Fighting

​You are spawning a Topmost WPF CurtainOverlay on every monitor, while simultaneously trying to keep the Topmost SessionIndicator banner visible. Windows often struggles with multiple un-owned topmost windows, leading to the overlay covering the banner.

- ​**The Fix:** In CurtainOverlay.cs, set the Owner property of the SessionIndicator window to the primary CurtainOverlay window, or explicitly call SetWindowPos via P/Invoke to force the banner to the absolute top of the Z-order after the curtains are rendered.

### ​3. GDI BitBlt vs. WDA_EXCLUDEFROMCAPTURE

​In **Step 2**, you noted using ScreenCapture.cs (GDI BitBlt).

While WDA_EXCLUDEFROMCAPTURE (0x11) is the correct flag (introduced in Windows 10 v2004), GDI's BitBlt is a legacy API. Depending on the target machine's graphics drivers and DWM (Desktop Window Manager) state, BitBlt occasionally fails to "see through" excluded windows, instead rendering a solid black rectangle exactly where your overlay sits, blinding the admin.

- ​**The Fix:** Test this immediately on a target machine. If the admin's stream shows a black box instead of the desktop, you will need to upgrade your ScreenCapture.cs engine to use **DXGI Desktop Duplication** or the **[Windows.Graphics](http://Windows.Graphics).Capture** API, both of which natively support WDA_EXCLUDEFROMCAPTURE.

### ​4. Handling the Ctrl+Alt+Del State Recovery

​In **Step 1**, you correctly planned to subscribe to SystemEvents.SessionSwitch to detect the override. However, when the user presses Ctrl+Alt+Del, Windows suspends BlockInput and switches them to the Winlogon Secure Desktop.

- ​**The Fix:** When the user exits the Secure Desktop and returns to the normal desktop, your agent must explicitly call InputBlocker.Release() and close the WPF overlays. If you don't actively tear down your UI when the SessionSwitch event fires, the user will return to a desktop where their input works, but their screens are still covered by your 55% black overlay.

&nbsp;

&nbsp;

### 1. Agent — new `InputBlocker.cs`

- P/Invoke `user32!BlockInput(bool)` and `user32!SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE = 0x11)`.
- Public API: `InputBlocker.Engage(reason)` / `InputBlocker.Release(reason)`, idempotent, thread-safe.
- Fail-safes (all wired at once):
  - `AppDomain.CurrentDomain.ProcessExit` + `UnhandledException` → `BlockInput(false)`.
  - Watchdog task: last "pause heartbeat" timestamp; if > 5s stale, auto-release.
  - Cancellation of the session token → auto-release.
  - `SystemEvents.SessionEnding` / logoff → auto-release.
- Ctrl+Alt+Del override detection: subscribe to `SystemEvents.SessionSwitch` (SecureDesktop transitions) — on trigger, log `curtain.overridden` back to admin via existing inputs/notify channel.

### 2. Agent — new `CurtainOverlay.cs` (WPF)

- Borderless, `Topmost`, `WindowStyle=None`, `AllowsTransparency=true`, one window **per monitor** (`Screen.AllScreens`).
- Background: 55% black, centered card with logo + copy: "Your IT administrator is performing maintenance. Input is temporarily disabled."
- On `Loaded`, grab HWND via `WindowInteropHelper` and call `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` so `ScreenCapture.cs` (GDI BitBlt) does not see it — admin's stream stays clean.
- Overlay is display-only; does not consume clicks (physical input is already blocked at the OS layer, and admin input arrives via `SendInput` which is unaffected by `BlockInput` when the agent runs elevated).

### 3. Agent — wire into existing session flow

- Extend `InputRelay.Apply` with two new kinds: `curtain_on`, `curtain_off`.
  - `curtain_on` → `InputBlocker.Engage()` + show `CurtainOverlay` on all monitors + start watchdog ping loop that refreshes the "pause heartbeat" every 1s while the admin holds control.
  - `curtain_off` → close overlays + `InputBlocker.Release()`.
- `SessionIndicator` gains a red "PAUSED — admin in control" state (already has `SetControlGranted` hook); user can still End via banner, which triggers the standard end path and releases the curtain.
- `Agent.EndSession` and the `_cts` cancel path both call `InputBlocker.Release()` unconditionally.

### 4. Elevation requirement

`BlockInput` and `SetWindowDisplayAffinity` require the agent to run with admin/interactive privileges. Update:

- `agent/INSTALL.md`: add a "Run elevated" section documenting `schtasks /RL HIGHEST` (already there) and a manifest-based UAC prompt for `dotnet run` dev mode.
- Add `app.manifest` with `requestedExecutionLevel level="requireAdministrator"` referenced from `ConnectLiveAgent.csproj`.
- If `BlockInput` returns false at runtime, agent logs and emits `curtain.unavailable` back to admin instead of silently doing nothing.

### 5. Admin panel

- In `src/routes/_authenticated/admin.tsx` live-view modal:
  - Rename the current "Pause user (take control)" toggle to **"Curtain (take control)"** with a red state and lock icon.
  - When toggled ON: POST `{ kind: "curtain_on" }` to `session.$sessionId.inputs`, set session mode to `control`, and start a 1s "pause heartbeat" pinger that re-sends `curtain_on` (so a stale admin tab auto-releases via the agent's 5s watchdog).
  - When toggled OFF, on modal close, on tab hide (`visibilitychange`), or on unmount: POST `{ kind: "curtain_off" }` and drop mode back to `view`.
  - Show a small banner in the admin view when the agent reports `curtain.overridden` (Ctrl+Alt+Del) or `curtain.unavailable`.
- No schema changes needed — reuses `session_inputs` for commands and `session_frames` for the (now overlay-free) stream.

### 6. Safety invariants (kept intact)

- Standing consent is still required before any session starts; curtain mode is only reachable inside an already-consented session.
- The `SessionIndicator` banner is still visible and draggable during curtain — the user always sees who is in control and can End.
- Overlay copy is plain, non-deceptive, ConnectLive-branded. No stealth mode, no capture without banner.
- Every curtain on/off is written to `audit_logs` server-side.

### Files touched

- New: `agent/src/InputBlocker.cs`, `agent/src/CurtainOverlay.cs`, `agent/src/app.manifest`
- Edit: `agent/src/InputRelay.cs`, `agent/src/Agent.cs`, `agent/src/App.xaml.cs`, `agent/src/SessionIndicator.cs`, `agent/src/ConnectLiveAgent.csproj`, `agent/INSTALL.md`
- Edit: `src/routes/_authenticated/admin.tsx`, `src/routes/api/public/agent/session.$sessionId.inputs.ts` (accept `curtain_on/off`, write audit rows)
- Repackage: `public/ConnectLiveAgent.zip` + `/mnt/documents/ConnectLiveAgent.zip`

Ready to implement on approval.