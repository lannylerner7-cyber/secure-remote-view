## Fix build errors in Admin and Agent

### Admin: `admin/src/ViewModels/LiveSessionViewModel.cs`
`DeviceItem` exposes `RowId` (the `devices.id` UUID), not `Id`. `EnqueuePowerCommandAsync` takes `deviceRowId`, so:

- Line 125: change `Device.Id` → `Device.RowId`.

### Agent: `agent/src/DxgiCapture.cs`
Align with Vortice.DXGI / Vortice.Direct3D11 3.6.2 API surface:

- Line 73: `adapter.GetOutput(0)` → `adapter.EnumOutputs(0)`.
- Lines 78–79: `desc.ModeDesc.Width/Height` → `desc.ModeDescription.Width/Height`.
- Texture2DDescription (lines 84–94): cast dimensions to `uint`:
  - `Width = (uint)_width`
  - `Height = (uint)_height`
  - `MipLevels = 1u`
  - `ArraySize = 1u`
- Line 132: `_duplication.AcquireNextFrame(timeoutMs, ...)` → cast timeout to `(uint)timeoutMs`.
- Update `_width`/`_height` capture (still `int`) — only the DXGI struct assignments get the `uint` cast; internal fields stay `int` so Bitmap/Rectangle usage is unchanged.

No other files touched; no logic changes. After edits, both projects compile against the pinned Vortice / SIPSorcery versions already in the csproj files.
