## Fix Vortice DXGI build errors in agent

Only file touched: `agent/src/DxgiCapture.cs`. Repackage `ConnectLive-RemoteAgent-src.zip` only.

### 1. Adapter output enumeration (lines 73–74)

Vortice's `IDXGIAdapter.EnumOutputs` returns a `Result` struct and hands the output back via an `out` parameter — not a return value — so `using var output = adapter.EnumOutputs(0)` fails to compile.

Replace:
```csharp
using var output = adapter.EnumOutputs(0);
using var output1 = output.QueryInterface<IDXGIOutput1>();
```
with:
```csharp
adapter.EnumOutputs(0, out IDXGIOutput output);
using (output)
using (var output1 = output.QueryInterface<IDXGIOutput1>())
{
    _duplication = output1.DuplicateOutput(_device);
    var desc = _duplication.Description;
    _width  = (int)desc.ModeDescription.Width;
    _height = (int)desc.ModeDescription.Height;

    var stagingDesc = new Texture2DDescription { /* unchanged */ };
    _staging = _device.CreateTexture2D(stagingDesc);

    _initialized = true;
    Log.Info($"DXGI: Desktop Duplication initialized {_width}x{_height}");
    return true;
}
```
(Move the existing `DuplicateOutput` / staging setup / `_initialized = true` / `Log.Info` / `return true` block inside the new `using` scope so `output1` stays alive.)

### 2. `int` cast for `RowPitch` (line 163)

`MappedSubresource.RowPitch` is `uint` in Vortice. Change:
```csharp
int srcStride = map.RowPitch;
```
to:
```csharp
int srcStride = (int)map.RowPitch;
```

### 3. Repackage

Rebuild the agent source zip only (`ConnectLive-RemoteAgent-src.zip`). Skip the admin zip this turn.