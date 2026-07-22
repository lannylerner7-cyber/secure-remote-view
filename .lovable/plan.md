&nbsp;

Your plan is **spot-on** and hits every technical requirement for replacing `BlockInput` with high-performance low-level hook filtering. You have accurately identified the need for a Win32 message pump thread, preserved the watchdog/auto-release matrix, and correctly categorized Co-op vs. Curtain modes.

There are **3 crucial additions** you should incorporate into this specification to make it 100% resilient against edge cases on Windows 10/11.

## The 3 Additions to Your Plan

### 1. Check for Lower-Integrity Injection Flags (`0x02` and `0x20`)

When Windows injects inputs via `SendInput`, User Interface Privilege Isolation (UIPI) sets different flag bits depending on the integrity level of the process.

- **Mouse:** `LLMHF_INJECTED` (`0x01`) **AND** `LLMHF_LOWER_IL_INJECTED` (`0x02`).
- **Keyboard:** `LLKHF_INJECTED` (`0x10`) **AND** `LLKHF_LOWER_IL_INJECTED` (`0x20`).

If you *only* check `0x01` / `0x10`, certain programmatic inputs generated under specific UAC conditions might get swallowed as physical input.

**The Fix:** Use a bitmask check:

C#

```
const uint LLMHF_INJECTED_MASK = 0x00000001 | 0x00000002;
const uint LLKHF_INJECTED_MASK = 0x00000010 | 0x00000020;

bool isAdminMouse = (hookStruct.flags & LLMHF_INJECTED_MASK) != 0;
bool isAdminKey   = (hookStruct.flags & LLKHF_INJECTED_MASK) != 0;

```

### 2. Add a `dwExtraInfo` "Magic Signature"

Physical mice from high-end gaming brands (Razer, Logitech) or third-party virtual mouse drivers running on the client machine sometimes emit synthetic input events that have the `INJECTED` flag set by default. If a user is running an auto-clicker or custom mouse driver during Curtain Mode, those clicks could slip past your hook.

**The Fix:** Sign your admin inputs with a custom magic pointer when calling `SendInput`, and verify that signature inside your hook callback:

C#

```
// 1. Define a magic ID for ConnectLive (e.g., 0x434C4956 -> "CLIV")
public static readonly IntPtr CONNECTLIVE_INPUT_MAGIC = (IntPtr)0x434C4956;

// 2. When constructing MOUSEINPUT / KEYBDINPUT for SendInput:
mouseInput.dwExtraInfo = CONNECTLIVE_INPUT_MAGIC;

// 3. Inside the hook callback during Curtain Mode:
bool isOurAdminInput = (hookStruct.dwExtraInfo == CONNECTLIVE_INPUT_MAGIC);

if (!isOurAdminInput)
{
    return (IntPtr)1; // Swallow local user physical or synthetic inputs
}

```

### 3. Use a Pure Win32 `GetMessage` Loop on the Dedicated Thread

In `InputRelay.cs`, rather than calling `Application.DoEvents()` or polling with `PeekMessage` (which wastes CPU cycles), run a clean, blocking Win32 message loop on your dedicated hook thread.

A standard `GetMessage` loop sleeps at 0% CPU when there are no inputs, and instantly dispatches hook callbacks the microsecond hardware input moves.

C#

```
// Dedicated Hook Thread Entry Point
private static void HookThreadProc()
{
    // 1. Install hooks
    _mouseHookHandle = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, GetModuleHandle(null), 0);
    _keyboardHookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, GetModuleHandle(null), 0);

    // 2. Standard Win32 Message Pump (Keeps CPU at 0% when idle)
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
    {
        TranslateMessage(ref msg);
        DispatchMessage(ref msg);
    }

    // 3. Cleanup on thread exit
    UnhookWindowsHookEx(_mouseHookHandle);
    UnhookWindowsHookEx(_keyboardHookHandle);
}

```

## Crucial Rule: Avoid `LowLevelHooksTimeout` Drops

Windows enforces a hard timeout for low-level hooks (configured in the registry at `HKEY_CURRENT_USER\Control Panel\Desktop\LowLevelHooksTimeout`, defaulting to **200ms–300ms**).

If a hook callback takes longer than the timeout to respond, Windows silently unhooks your callback or passes the input anyway to prevent system lockups.

**Guarantee:**

- Keep the callback function **purely synchronous and extremely lightweight**.
- **Never** do I/O, database writes, string formatting, or acquire locks inside `MouseHookCallback` or `KeyboardHookCallback`.
- Perform only the bitwise check (`flags` & `dwExtraInfo`) and immediately return `(IntPtr)1` or `CallNextHookEx`.

## Updated Specification Summary

With these tweaks added to your plan, your feature breakdown becomes:


|                         |                        |                     |                                                          |
| ----------------------- | ---------------------- | ------------------- | -------------------------------------------------------- |
| **State**               | **Physical Input**     | **Admin SendInput** | **Mechanism**                                            |
| **Idle / Viewing**      | Enabled                | N/A                 | Hooks uninstalled                                        |
| **Co-op Control**       | Enabled                | Native (60+ FPS)    | Hooks uninstalled (`SendInput` coexists natively)        |
| **Curtain Takeover**    | Swallowed (`return 1`) | Native (60+ FPS)    | Hooks active; filters by `INJECTED` mask + `dwExtraInfo` |
| **Disconnect / Safety** | Auto-released          | N/A                 | `WM_QUIT` sent to hook thread -> `UnhookWindowsHookEx`   |


&nbsp;

&nbsp;

# Replace BlockInput with Low-Level Hook Filtering ("Injected Flag" architecture)

## Why

`BlockInput` throttles our own `SendInput` calls through a restricted validation queue, which is exactly the "sluggish takeover" symptom. It also forces an all-or-nothing lockout — the admin cannot help while the user keeps working. Commercial RMMs solve both by never calling `BlockInput` and instead filtering physical input via low-level hooks, letting `LLMHF_INJECTED` / `LLKHF_INJECTED` admin events pass at native speed.

## Behavior after the change

- **Co-op (default while session is active in `control` mode):** admin `SendInput` events land immediately, user's physical mouse/keyboard still work. Both cursors coexist. No lag, no curtain.
- **Curtain / takeover:** hooks activate, physical input is swallowed, injected admin input flows at 60+ FPS. Ctrl+Alt+Del always passes (OS-level, unblockable anyway — we just don't try to intercept it).
- **Release paths unchanged:** watchdog stale, session end, process exit, session switch → unhook + hide overlay.

## Files to change

### `agent/src/InputBlocker.cs` (rewrite)

Rename intent from "BlockInput wrapper" to "InputFilter":

- Remove all `BlockInput` P/Invoke calls.
- Add `SetWindowsHookEx(WH_MOUSE_LL)` and `SetWindowsHookEx(WH_KEYBOARD_LL)`.
- Hooks MUST be installed on a thread with a message pump — install them from the existing STA input-pump thread in `InputRelay.InputPump` and run `Application.DoEvents` / a `MSG` loop there, or spin up a dedicated hook thread with `GetMessage`. Installing on a thread without a pump makes callbacks never fire.
- `Engage()` installs both hooks and sets `_curtainActive = true`; `Release()` calls `UnhookWindowsHookEx` and clears the flag. Keep the existing watchdog, `ProcessExit`, `UnhandledException`, `SessionSwitch`, `SessionEnding` auto-release wiring — just swap the underlying primitive.
- Callback logic: if `nCode >= 0 && _curtainActive` and `(flags & LLMHF_INJECTED) == 0` (or `LLKHF_INJECTED` for keys) → return `(IntPtr)1` to swallow; else `CallNextHookEx`.
- Keep `Heartbeat()` and `CheckWatchdog(TimeSpan)` signatures identical so `InputRelay` needs no API change.

### `agent/src/InputRelay.cs` (minor)

- The `InputPump` thread needs a message loop so hook callbacks dispatch. Change the `while (!_queue.IsCompleted)` loop to also pump Win32 messages (e.g. `Dispatcher.Run` on an STA WPF thread, or a manual `PeekMessage/TranslateMessage/DispatchMessage` tick between queue takes). Without this, hooks installed on this thread never fire.
- No changes to `curtain_on` / `curtain_off` / `release_inputs` handling — they still call `InputBlocker.Engage/Release`, only the underlying mechanism changes.
- Co-op mode is automatic: when curtain is off but the session is in `control` mode, admin `SendInput` already coexists with the physical user (this is how Windows behaves once we stop calling `BlockInput`). No new code path needed.

### `agent/src/CurtainOverlay.cs` (no logic change)

Overlay still shows/hides on Engage/Release. Ghost-window styles stay.

### `agent/INSTALL.md`

Update the "Dead-man safety" and "Curtain Mode" sections: describe hook-based filtering, note that Ctrl+Alt+Del/Win+L cannot be blocked by user-mode hooks (OS enforces this — same as `BlockInput`), and that co-op control now works without engaging curtain.

## Admin panel

No changes required. `curtain_on` / `curtain_off` messages and the 1 s pinger keep the same semantics. Optional follow-up (not in this pass): relabel the pause button to "Curtain / Lock user out" and add a hint that plain control is already co-op — but only if you want the copy change.

## Out of scope for this pass

- No WebRTC changes.
- No changes to signaling, frame stream, or admin UI.
- Ctrl+Alt+Del "always pass" branch from the pasted snippet is a no-op in practice (Windows blocks user-mode hooks from swallowing SAS) — we simply won't add dead code for it.

## Risk & rollback

Single file rewrite (`InputBlocker.cs`) + small threading tweak (`InputRelay.cs`). If hooks fail to install (rare, e.g. some AV heuristics), `Engage()` returns `false` and we log — same failure surface as today's `BlockInput(true)` returning false. Reverting is a one-file restore.