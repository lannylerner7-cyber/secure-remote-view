## Plan

### 1. The WPF Equivalent for Ghost Windows

You correctly noted that WPF does not use `CreateParams` like WinForms. To apply Win32 extended styles to a WPF window, you must wait until the underlying OS window handle (HWND) is created. You do this by overriding `OnSourceInitialized` in your `CurtainOverlay.xaml.cs`.

Here is the exact code to drop into your `CurtainOverlay.cs` file to apply `WS_EX_NOACTIVATE` and `WS_EX_TRANSPARENT`:

C#

```
using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

public partial class CurtainOverlay : Window
{
    // Win32 Constants
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_NOACTIVATE = 0x08000000;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);

    public CurtainOverlay()
    {
        InitializeComponent();
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);

        // Get the underlying Win32 handle for this WPF Window
        var hwnd = new WindowInteropHelper(this).Handle;

        // Fetch current extended styles
        int extendedStyle = GetWindowLong(hwnd, GWL_EXSTYLE);

        // Append the Ghost styles (Transparent to clicks + No Keyboard Focus)
        SetWindowLong(hwnd, GWL_EXSTYLE, extendedStyle | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);

        // Note: WDA_EXCLUDEFROMCAPTURE (SetWindowDisplayAffinity) is a separate API call.
        // You should call it here as well, passing in the 'hwnd' variable.
    }
}

```

### 2. Validating the Dedicated Input Thread

This is the most critical architectural win in your plan. Calling `BlockInput(true)` locks the physical keyboard and mouse, but it **also** blocks programmatic `SendInput` calls if they come from a different thread. By moving the polling, `BlockInput`, and `SendInput` replay onto a single, dedicated loop:

- You serialize all inputs perfectly.
- You ensure your admin inputs are executed by the exact thread that owns the `BlockInput` lock.
- When that thread exits, dies, or receives a kill signal, `BlockInput(false)` is guaranteed to fire safely.

### 3. The "State Change" Signal Filtering Fix

Your observation about the queued `curtain_off` command being swallowed because the session state changed to `ended` is brilliant. This is a classic race condition that plagues custom RMMs.

- **The fix:** Updating the backend to allow cleanup commands (`curtain_off`, `release_inputs`) to bypass the `active/control` state check is exactly the right move. The agent should *always* obey a safety release command, regardless of the database's session state.

### 4. Keystroke Batching & Trackpad Throttling

- **Batching `Ctrl+V` / `Ctrl+A`:** Yes. Firing separate database inserts for `KeyDown(Ctrl)` and `KeyDown(V)` introduces network-induced timing drift. Sending them as a single JSON array (e.g., `[{"key":"Ctrl","state":"down"}, {"key":"V","state":"down"}, ...]`) allows your C# agent to replay them instantly with microsecond precision.
- **Trackpad Throttling:** Highly recommended. Instead of sending absolute math coordinates for the virtual trackpad, sending relative `[dx, dy]` deltas every ~50ms smooths out the network flood and makes the C# mouse movement vastly more predictable.

### Final Verdict

Do not change a thing. Your plan fixes the root UIPI elevation constraints via documentation, patches the WPF window focus trap with native Win32 calls, completely isolates the input serialization thread, and hardens the exit pathways against race conditions. It is ready to execute

&nbsp;

&nbsp;

1. **Keep elevation behavior, but make it clear and automatic**
  - The normal-terminal `dotnet run` failure is expected because `app.manifest` requests administrator rights for Curtain Mode.
  - Update the agent docs/package with a one-line PowerShell launcher that self-elevates for local testing.
  - Keep the production installer/service path as the recommended flow.
2. **Fix Curtain Mode so it does not steal focus**
  - Update the WPF curtain windows to use Win32 extended window styles after their handles are created:
    - `WS_EX_NOACTIVATE` so keyboard focus stays on the real app behind the curtain.
    - `WS_EX_TRANSPARENT` so the overlay does not consume mouse targeting.
    - Keep `WDA_EXCLUDEFROMCAPTURE` so the curtain stays visible to the local user but hidden from the admin stream.
  - Do this in `CurtainOverlay.cs`; the pasted WinForms `CreateParams` pattern needs a WPF equivalent.
3. **Make admin input work while local input is blocked**
  - Current code engages `BlockInput` from the WPF UI thread, while mouse/keyboard replay happens from the polling thread. That can make admin `SendInput` sluggish or ignored.
  - Move input replay and `BlockInput` ownership into one dedicated input pump/thread so:
    - Curtain engage/release runs consistently.
    - Mouse moves, clicks, wheels, and keys are serialized in order.
    - The same controller owns release during disconnect/cancel/crash paths.
4. **Guarantee release on End Session and mode changes**
  - The current input endpoint only returns commands while `session.state === "active"` and `mode === "control"`. If the admin ends the session first, a queued `curtain_off` can be filtered out and never reach the agent.
  - Change the agent input poll route so release/safety commands (`curtain_off`, session-ended safety release) can still be delivered when the session is no longer active/control.
  - Update admin `endSession` to enqueue a release command before marking the session ended, and keep the existing best-effort cleanup on live-view close.
5. **Improve on-screen keyboard reliability**
  - Send key combos as a single ordered batch where possible, instead of separate database inserts per key event.
  - Add small delays/ordering guarantees for `Ctrl+A/C/V`, Enter, Backspace, and Delete so the agent replays them predictably.
6. **Clean up trackpad movement**
  - Simplify the virtual trackpad math so movement speed is stable and not artificially tiny.
  - Keep the resizable UI, but send meaningful relative deltas with throttling to avoid flooding the backend.
7. **Update package artifacts**
  - Refresh `agent/INSTALL.md` with normal CMD vs elevated CMD explanation and the self-elevating PowerShell command.
  - Rebuild the updated `ConnectLiveAgent.zip` so the downloadable package reflects the fixes.

## Technical notes

- I will not add a low-level mouse hook unless the current code actually uses one; the current agent uses `BlockInput` + `SendInput`, so the fix should target that architecture.
- The goal is instant safety release: admin toggles off, admin ends session, tab closes, polling stops, app exits, or Windows session changes should all release input and hide the curtain.