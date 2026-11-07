# Codec recovery and JPEG clarity update — 2026-11-06

## Current delivery status

The browser recovery controller and Agent 1.10.5 source are implemented, but
**full recovery is not end-to-end verified and is not certified for release**.
No Windows binary or installer was built, and production deployment was not part
of this implementation. Publishing the source does not certify either runtime gate.

The native source separates JPEG detail from video downscaling: native pixels
up to UHD-sized bounds, quality 86/94, adaptive lower cadence and a base64-safe
payload cap. It does not invent 4K detail from a lower-resolution desktop.
VP8 uses an actual synthetic encode probe; unavailable VP8 no longer prevents
hardware H.264 setup. Hardware encoding consumes the capture's RGBA contract
and failures require a fresh negotiation rather than mixing codecs.

The browser uses one peer at a time in the same authorized session, with
H.264-preferred/VP8, VP8-only and relay-only retry profiles. Healthy video is
retained. Permission denial and supersession stop recovery. Recording
finalization is bounded and shared with an overlapping manual Stop; repeated
playback-state notifications cannot reset retry backoff.

### Checks completed

- TypeScript and the production web build passed.
- 41 isolated media, permission, freshness and recovery tests passed.
- 18 mocked ICE/transport scenarios and 19 recording assertions passed.
- Static native capture/lifecycle checks and source-archive dependency,
  checksum and no-binary checks passed.
- The complete source ZIP contains 108 source/reference files. It requires
  a manual Windows build; archive validity is not Windows runtime evidence.

### Browser evidence and remaining blockers

Only guarded, disposable identities and synthetic devices were used.
The first browser pass rendered canvas-generated H.264 video over a host
connection. Recording did not start despite a separately confirmed recording
grant, so that pass did not verify saving or recovery. The initial cause was
not isolated.

After bounded recording verification, pending-state feedback, shared
finalization and parallel capability lookups were added, the focused pass
displayed authorized JPEG fallback and automatic retry attempts. It did not
regain video: ICE stayed `new`, and the video element had no track or dimensions
through attempt 11. Consequently recording remained disabled and no recording
segment was produced. Answer/candidate write acceptance alone did not prove
that the current receiver applied the intended answer. The cause remains
unisolated between the synthetic sender/signaling setup and application
transport; this is not evidence of a native Windows encoder failure.

Both browser fixtures were cleaned up. A transient tool capture exposed only a
disposable fixture's one-time pairing code; it was consumed by that fixture,
excluded from attached screenshots, and removed with fixture cleanup. No real
customer device or session was operated.

Remaining work is a reproducible browser recovery/recording harness and actual
Windows verification of encoding, color, text clarity, direct/TURN transport
and reconnection. Do not describe those gates as passed.

The earlier entry below describes the preceding fallback-only update, not
certification of the newer codec controller or Agent source.

# Admin video-to-JPEG recovery — 2026-11-06

## Cause and correction

The browser previously created sessions for current Windows Agents with
`media_mode: "video"`. This is an explicit **video-only** contract: the Agent
does not upload JPEGs, the frame endpoint rejects them, and a database trigger
also rejects them. A failed reconnect could not activate JPEG in that session.

New browser invitations now use the existing `legacy` transport contract,
which supports **WebRTC video plus HTTPS JPEG**, not JPEG instead of video.
Video remains preferred. This requires no migration or native rebuild.

The viewer also used to remember its first decoded frame indefinitely while
ICE remained connected. It now measures actual new frames:

- No new video frames for five seconds makes the picture stale, even when
  ICE is connected, the media element unexpectedly pauses, or cursors move.
- The permitted JPEG subscription and HTTP polling resume automatically.
- Fresh video frames automatically restore the video surface.
- A replacement peer starts with no inherited “decoding” evidence.
- A deliberate local viewer pause still suppresses JPEG downloads.
- Fresh JPEGs are labeled as frame fallback even while video negotiation runs.

The JPEG upload path already exists in the current Agent source. Its existing
server/database authorization rules, recording rules and input permissions
were not loosened. JPEG freshness is not evidence of WebRTC health.

## Existing video-only sessions

The media mode of an existing session remains immutable.
The admin viewer explains this and offers **Enable JPEG fallback**:

1. Ask the technician to confirm ending the old session.
2. Verify that ending succeeded.
3. Invite a new **view-only** session that permits both transports.
4. Require the normal recorded viewing grant and, for attended access,
   local approval.

Cancelling, a failed end, or a failed invite must not report success. No device
is re-paired, relaunched or granted additional capabilities by this action.
Reusing an existing video-only session does not silently change its contract.

## Verification

- TypeScript and whitespace checks passed.
- 26 isolated viewer/media checks passed: new-session selection, guarded JPEG
  writes, confirmed replacement sequencing, cursor-independent JPEG recovery,
  frame staleness, older-browser counters, recovery and callback cleanup.
- Existing browser protocol, input permission, reconnect authorization and
  native source-regression checks passed.
- Exported-source BTC tests (25), guide tests (56), payment identity checks
  (15), runtime-cache checks (21) and pricing regression checks passed.
- GitHub-root source installed with Bun 1.3.6, a fresh package cache and the
  frozen committed lockfile; its Node-server production build passed.
  Build used dummy public settings and no production secrets.
- The built Node server returned 200 for `/health`, `/api/public/health`,
  `/connectlive/admin` and `/connectlive/payment`, then was stopped.

### Signed-in browser evidence

The real admin console was exercised with a disposable administrator identity,
synthetic device/session records, intercepted writes and canvas-generated video.
No real device was connected, controlled, ended, restarted or re-paired.

Observed:

- Connect sent `mode: view`, `state: invited`, `media_mode: legacy`.
- A generated JPEG decoded at 480×270 and remained visible while video was
  frozen and cursor updates continued; its label said **Frame fallback**.
- Resuming canvas video hid the JPEG and showed **WebRTC video** at 10 fps.
- Reconnect replaced the video element, cleared prior decoding evidence,
  and returned to JPEG without using the fallback-enablement action.
- Opening an existing video-only session produced no JPEG reads or image.
- Dismissing confirmation caused no mutation. A simulated failed end created
  no replacement. Successful replacement ended the old session first, then
  invited a new view-only fallback-capable session.

The exact initial-connecting interval was not captured before a role-resolution
problem in the test browser prevented a final step after reload. Some 403s came
from the test interception layer; the specific reload failure was not established.
A subsequent direct check of the actual role RPC returned 200 and the expected
admin role twice, and the disposable license remained active. This is not a
claim that the uncompleted browser step passed.

These checks establish viewer behavior with synthetic transports, not Windows
capture, native Agent signaling, TURN connectivity or the production revision.
The disposable identity and license are removed after testing.

### Read-only operational observations

The latest stored session at inspection was active and video-only, with four
browser offers, zero Agent answers, zero Agent ICE rows and no JPEG row.
Its device heartbeat was not recent at that instant. This does not prove the
encoder failed; the stored signaling had not reached an Agent answer.
No SDP, ICE credentials, customer screen images or device identifiers were
retrieved for this report, and no live session was ended or changed.

The externally hosted health endpoints and technician sign-in returned 200.
That establishes reachability, not successful native media or the deployed
revision. GitHub publication and Coolify deployment are separate evidence.

## Remaining boundaries

- Actual Windows capture, Agent acceptance, direct/TURN video and reconnection
  still need evidence from an explicitly designated Windows test device.
- The native Windows Admin already contains a JPEG fallback pump. It was
  inspected, not changed or executed in this Linux workspace.
- No native binaries were compiled or packaged.
- Existing development logs include TanStack deprecation/CSRF warnings and
  aborted requests; this release does not claim warning-free logs.
