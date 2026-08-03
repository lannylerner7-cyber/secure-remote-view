# Fix the remaining Admin + Agent build errors (line edits, no repackaging)

## Admin — `src\Media\WebRtcClient.cs`, line 306-307

Replace these two lines:

```text
            pc.SendVideoRtcpFeedback(new RTCPFeedback(pc.VideoLocalTrack?.Ssrc ?? 0,
                pc.VideoRemoteTrack?.Ssrc ?? 0, PSFBFeedbackTypesEnum.PLI));
```

with:

```text
            pc.SendRtcpFeedback(SDPMediaTypesEnum.video,
                new RTCPFeedback(pc.VideoLocalTrack?.Ssrc ?? 0,
                    pc.VideoRemoteTrack?.Ssrc ?? 0, PSFBFeedbackTypesEnum.PLI));
```

Why: SIPSorcery 6.2.4 has no `SendVideoRtcpFeedback`. The real API on `RTPSession`/`RTCPeerConnection` is
`SendRtcpFeedback(SDPMediaTypesEnum mediaType, RTCPFeedback feedback)` — the media type is a parameter, not baked into the method name. The `RTCPFeedback(senderSsrc, mediaSsrc, PSFBFeedbackTypesEnum.PLI)` constructor is unchanged, so the PLI semantics stay identical. No new `using` needed — `SDPMediaTypesEnum` is in `SIPSorcery.Net`, already imported at the top of the file.

## Agent — two one-line edits (still outstanding from the previous message)

### `src\WebRtcSession.cs`, line 127

```text
            var cfg = await App.Api.GetIceConfigAsync(_cts.Token).ConfigureAwait(false);
```
becomes
```text
            var cfg = await _api.GetIceConfigAsync(_cts.Token).ConfigureAwait(false);
```

There is no static `App.Api`; the `ApiClient` lives in the instance field `_api` set by the constructor.

### `src\StreamListener.cs`, line 123

```text
            if (line.StartsWith(':', StringComparison.Ordinal)) continue;
```
becomes
```text
            if (line.StartsWith(":", StringComparison.Ordinal)) continue;
```

Only `':'` → `":"`. There is no `StartsWith(char, StringComparison)` overload.

## Warnings you can ignore

- `NU1903` SIPSorcery 6.2.4 advisory — warning only.
- `CS1998` in `Agent.cs` 275/293 — async without await; warning only.
- `WFAC010` high-DPI manifest — warning only.
- The `Copy-Item ... does not exist` / `Expected 'ConnectLive.exe'` failures are downstream of the compile errors: publish never emitted an exe. They clear once the errors above are fixed.
- The `ConnectLiveAdmin_bscs1v4y_wpftmp.csproj` name in the log is just the WPF temporary project the SDK generates — not a stray file.

## After the edits

Re-run `powershell -ExecutionPolicy Bypass -File build.ps1` in each folder. Admin should produce `dist\ConnectLiveAdmin.exe`; Agent should produce `dist\ConnectLive.exe` plus the installers if Inno/WiX are on PATH.

I will also apply all three fixes in the repo so the next source zip is clean.
