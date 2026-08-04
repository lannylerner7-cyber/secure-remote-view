# Native Admin console: dead buttons + badly fitted live video

Two separate defects, both in the WPF admin client. Findings below come from reading the actual files this session.

## What is actually wrong

**1. The live-session toolbar buttons are pushed off-screen.**
`admin/src/Views/LiveSessionWindow.xaml` puts the whole top bar in one `DockPanel`. The left status panel (LIVE dot, device name, transport pill, link state, the long `VideoStats` readout, plus a 190px monitor picker) is declared first and is free to grow to any width. The action panel (Reconnect, Restart stream, Restart agent, Curtain, Lock, Restart, Shutdown, End session — eight buttons) is the last child, so it only gets whatever horizontal space is left. At the default 1200px window with a populated stats string there is little or none, so the buttons are clipped outside the visible area and the bar looks unresponsive.

**2. Keyboard activation of any control is swallowed.**
The window installs `PreviewKeyDown`/`PreviewKeyUp` at window level and marks every non-printable key handled (`Views/LiveSessionWindow.xaml.cs`). That includes Enter, Space, Tab and the arrows, so nothing in the chrome can be reached or triggered by keyboard — correct while the remote surface is focused, wrong for the toolbar.

**3. Device-list buttons need a click to wake up.**
`Views/MainWindow.xaml` hosts Connect / Wake / Delete inside a `DataGridTemplateColumn`. The grid takes the first click for row/cell selection, so the button appears to ignore the first press.

**4. The picture never fits the window.**
The `Image` is `Stretch=Uniform` + `StretchDirection=DownOnly` with no fit/zoom control, and the window opens at a fixed 1200x720 rather than maximised. A 4K source is squeezed into roughly a 1100px-wide box; anything below the element size is drawn small and centred inside black bars. On top of that, the take-over banner and the amber status banner live in the *same* `Grid` as the video and are top-aligned, so they cover the top of the desktop image instead of sitting outside it.

## What will change

**Toolbar (LiveSessionWindow.xaml)**
- Dock the action buttons first so they always reserve their width; the status panel takes the remainder and clips with an ellipsis instead of squeezing the buttons out.
- Split the bar into two rows when narrow (status row + actions row) so all eight buttons stay reachable at any window size.
- Group the destructive power actions (Lock / Restart / Shutdown) behind a single "Power" dropdown to cut the bar down from eight controls to five.
- Give every button a sensible `MinWidth`, tooltip and keyboard-reachable focus.

**Key interception (LiveSessionWindow.xaml.cs)**
- Only intercept keys when the video surface (the `Grid`/`Image`) holds focus. When focus is in the toolbar, let WPF handle Tab/Enter/Space normally.
- Clicking the picture returns focus to the surface, exactly as it does today.

**Video fit**
- Move the banners out of the video `Grid` into their own docked rows, so the picture is never covered.
- Add a Fit / 1:1 toggle in the bar: Fit uses `Uniform` with upscale allowed (so a 1280px rung fills the window instead of floating in the middle); 1:1 keeps `DownOnly` native pixels inside a scroll viewer for pixel-accurate work.
- Keep `ContentRect.Compute`'s `allowUpscale` argument driven off the element's live `StretchDirection`, which is already how `Rect()` reads it — so clicks, wheel and the ghost cursor stay correct in both modes without touching the input maths.
- Open the live window maximised so the default experience uses the whole display.

**Device list (MainWindow.xaml)**
- Make the action cells respond on the first click (single-click cell activation on the template column).

## Technical notes

- Files touched: `admin/src/Views/LiveSessionWindow.xaml`, `admin/src/Views/LiveSessionWindow.xaml.cs`, `admin/src/Views/MainWindow.xaml`, and a small style addition in `admin/src/App.xaml`.
- No transport, WebRTC, capture or ViewModel command changes. `PowerCommandCommand`, `ToggleControlCommand`, `RestartStreamCommand`, `RestartAgentCommand` and `ReconnectAgentCommand` already exist and are correctly wired — they were simply unclickable.
- `PROJECT-MAP.md` gets a short entry recording the toolbar layout and Fit/1:1 invariants (the `allowUpscale` ↔ `StretchDirection` coupling is already documented in `ContentRect.cs` and must stay true).
- This is XAML/code-behind only; the project still needs a Windows build to verify visually, so a fresh sanitized Admin zip can be cut afterwards if you want it.
