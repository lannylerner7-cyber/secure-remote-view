# Fix the Agent build without repackaging

Two one-line edits in the downloaded zip. Both files are already correct in the repo — your local copy is the pre-fix version.

## 1. `src\WebRtcSession.cs` — line 127

Replace:

```text
            var cfg = await App.Api.GetIceConfigAsync(_cts.Token).ConfigureAwait(false);
```

with:

```text
            var cfg = await _api.GetIceConfigAsync(_cts.Token).ConfigureAwait(false);
```

Why: there is no static `App.Api`. The `ApiClient` is held in the instance field `_api` (set in the constructor). `App.Api` is the leftover of an earlier singleton design and is what the CS0117 is complaining about.

## 2. `src\StreamListener.cs` — line 123

Replace:

```text
            if (line.StartsWith(':', StringComparison.Ordinal)) continue; // keepalive comment
```

with:

```text
            if (line.StartsWith(":", StringComparison.Ordinal)) continue; // keepalive comment
```

Only the `':'` → `":"` change (single quotes to double quotes). `string.StartsWith(char, StringComparison)` does not exist — only `(string, StringComparison)` does. That is the CS1503.

## What you can ignore

- `NU1903` (SIPSorcery 6.2.4 advisory) — warning, not an error.
- `CS1998` in `Agent.cs` at 275 and 293 — async methods with no `await`. Warnings only; the build proceeds.
- `WFAC010` (high-DPI manifest) — warning only.
- The `Expected 'ConnectLive.exe' in 'publish/agent' but publish produced: (none)` message is a symptom of the two compile errors above — publish never wrote the exe, so the staging step had nothing to copy. It resolves itself once the two errors are fixed.

## After the edits

```text
powershell -ExecutionPolicy Bypass -File build.ps1
```

should produce `dist\ConnectLive.exe`, then `dist\ConnectLiveSetup.exe` (Inno) and `dist\ConnectLiveAgent.msi` (WiX) if those toolchains are on PATH.
