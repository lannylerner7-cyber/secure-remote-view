## Step 1 — Instrumentation (read-only, ship first)

Land only diagnostics, then run one session and read the logs before any fix.

**Agent — `agent/src/WebRtcSession.cs`**
- Extend the 5 s `webrtc video pipe` line to include `lastW x lastH` of the most recent `PushFrame` and the current negotiated payload id.
- Log every `OnVideoFormatsNegotiated` and every peer state transition with a monotonic ms timestamp.

**Agent — `agent/src/ScreenCapture.cs`**
- Log every `SetQualityMode` transition with the timestamp and old→new max-edge.
- Log the first `TeeToWebRtc` after each resolution change (dimensions + `throttled` flag).

**Web — `src/lib/webrtc-live.ts`**
- Extend the media watchdog probe to also record `pliCount`, `nackCount`, `keyFramesDecoded`, `framesDropped`, `frameWidth`, `frameHeight` alongside `framesDecoded`. Log once every 3 s tick.

**Verification run**
- Open a live session, hold still 10 s, then drag a window continuously for ~60 s to force motion + possible mode flip.
- Capture: agent `%LOCALAPPDATA%\ConnectLive\agent.log`, browser console.
- Decision rule:
  - Corruption present from **frame one** with `framesDecoded` climbing but visible stripes → fix #1 (RTP duration).
  - Corruption starts **at a `SetQualityMode` line** → fix #2 (resolution stability).
  - `pliCount` rising with `keyFramesDecoded` flat → fix #3 (keyframe-on-loss).

## Step 2 — Fix, driven by Step 1 evidence

Only the fix(es) the logs justify. Details:

1. **RTP duration from real delta.** In `PushFrame`, replace the constant `33` with `(int)((nowMs - lastPushMs) * 90)` clamped to `[1500, 15000]` (≈60 fps floor, ≈6 fps ceiling), computed against a monotonic `Stopwatch`. Keeps VP8 RTP timestamps accurate even when the capture loop drifts off 30 fps.
2. **Resolution stability.** Freeze the WebRTC tee resolution at first-frame dimensions per peer. `SetQualityMode` continues to affect the JPEG fallback; the tee ignores mode changes until the peer is rebuilt. On peer rebuild, `ResetWebRtcTee()` also clears the frozen size.
3. **Keyframe-on-loss.** Subscribe to SIPSorcery's PLI/RTCP-feedback event on the video track; call `_videoEnd.ForceKeyFrame()`. On the web side, when `framesDecoded` stalls but `bytesReceived` still rises, request a keyframe via a data-channel `keyframe_request` message before escalating to `iceRestart`.

## Step 3 — Wake for offline devices

The wake button reportedly no longer revives an offline agent. Independent of the video issue.

- Reproduce: close the agent process on a test device, click Wake, watch server-side `power_commands` and `stream.ts` behavior.
- Verify against current code:
  - `stream.ts` only serves connected agents; an *offline* agent has no SSE session, so it can't receive `wake`. The Windows-side revival path must be independent of the agent process.
  - Confirm whether the standalone-agent refactor removed the mechanism that previously started `ConnectLive.exe` on an admin wake (the old Updater service). If yes, we're missing a host that survives when the agent isn't running.
- Decide with the user between two options (**do not build yet**):
  - (A) Reintroduce a tiny SYSTEM-context launcher (scheduled task triggered on-event, or a minimal service) whose only job is to (re)start `ConnectLive.exe` when a wake row appears for this machine. Poll interval ≤ 5 s.
  - (B) Rely purely on the existing ONLOGON scheduled task + agent self-heal — accept that a fully-exited agent on a locked machine cannot be revived remotely.

Report the Step 1 logs and the wake reproduction findings before we commit to Step 2 or Step 3 code changes.

## Non-goals

- No TURN. STUN-only stays.
- No transport rewrite, no schema change, no version bumps in this pass.

## Technical notes

Files touched in Step 1 only: `agent/src/WebRtcSession.cs`, `agent/src/ScreenCapture.cs`, `src/lib/webrtc-live.ts`. Step 2/3 file lists are decided by evidence.
