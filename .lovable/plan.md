## Status

Step 1 instrumentation is already shipped in the codebase (agent `MonoClock` + pipeline/resolution/negotiation logs, capture mode-flip logs, web `mediaWatchdog` RTP stats every 3s). Nothing further needs to be written for Step 1.

The remaining work is a **capture run on your Windows machine** — I cannot execute the agent binary from here. Below is the exact procedure and the decision rule I will apply to your logs.

## Capture procedure (you run, ~90 seconds)

1. Install/refresh the v1.9.0 agent build, then start it and let it enroll.
2. Open the admin console, start a live session, open browser DevTools → Console (preserve log ON).
3. Timeline:
   - 0–10s: do nothing at all on the remote machine (static scene).
   - 10–70s: drag a window continuously around the screen (forces motion + likely quality-mode flip).
   - 70–90s: stop, stay still again.
4. Stop the session. Collect:
   - `%ProgramData%\ConnectLive\logs\agent.log` (last ~200 lines)
   - Full browser console text dump
   - Note the wall-clock second at which the picture first corrupts and at which it drops.

## Decision rule (evidence → single fix)

```text
IF web stats show frameWidth/frameHeight changing mid-session
   AND agent log shows a SetQualityMode / resolution-change line at the same moment
   -> Fix #2 only: freeze encoder resolution for session lifetime
      (quality mode changes JPEG path only, never the WebRTC track dims)

ELSE IF framesDecoded advances but keyFramesDecoded stays flat while
   pliCount/nackCount climb, and corruption grows progressively
   -> Fix #3 only: PLI/keyframe-on-loss handler + periodic IDR

ELSE IF agent "pushed" count is steady but web framesReceived rate is
   uneven/bursty, or playoutDelay/jitter grows monotonically
   -> Fix #1 only: derive RTP duration from real inter-frame delta
      (90kHz clock) instead of the fixed 33
```

If two conditions fire, I apply the earliest cause in the pipeline first (resolution → timestamp → keyframe) and re-measure before touching anything else.

## Guardrails for this pass

- STUN-only, no TURN.
- No database schema change.
- No transport rewrite.
- Only one of #1/#2/#3 gets applied, chosen by the rule above.

## Wake button

Parked. After the capture I will report what the logs show about the offline-device path (whether the SSE listener is even alive at wake time), but I will not build Option A (minimal launcher) or Option B (accept limitation) until you choose — after the video is clean.

## Next step after approval

Paste `agent.log` + console dump here. I will report the Step 1 findings first, name the single fix the evidence selects, and only then write Step 2 code.
