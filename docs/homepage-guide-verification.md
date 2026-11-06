# Homepage guide verification

Verified in the development preview on 2026-11-04. This is not a claim that the
external Coolify deployment was updated or that a physical iPhone was tested.

## Scope

Only the homepage guide, its approved-answer/voice/event endpoints, supporting
dependency, and knowledge documentation were changed. No Windows Agent,
remote-session, admin, checkout, or authentication behavior was changed.

## Confirmed

- Real ElevenLabs Bella audio, not browser speech synthesis or a mocked player.
  The greeting MP3 was decoded successfully; measured pauses included several
  half-second gaps. Voice is opt-in, with natural/unhurried pace controls.
- Real browser media time advanced. Pause froze media time and caption position;
  replay reset them. Manual board paging paused speech. Hiding the guide stopped
  sound, reopening stayed paused, and text worked with voice disabled.
- Enrollment's full 52-word answer appeared across three pages. In the WebGL
  browser, at media time 7.472 seconds, both the provider alignment and visible
  caption selected word index 22.
- The actual 3D stage rendered in Chromium using software WebGL. Observed
  movement included rising, walking forward, speaking, walking toward the board,
  presenting, walking back and sitting. The model and physical board were
  captured, not substituted with the still-image fallback.
- Desktop and 390-pixel phone layouts were inspected. The phone document had
  no horizontal overflow. Reduced-motion/no-WebGL mode retained the readable
  board, chat, real voice and controls.
- Product suggestions resolved to approved answers; an unrelated weather
  question returned the unverified-answer wording.
- Event requests contained allowlisted topics, phases, page numbers and timing,
  not visitor questions or persistent visitor IDs.
- Cross-site requests, oversized questions, unrestricted speech text, stale
  answer hashes, and event bodies containing free-form question text were
  rejected.
- All 28 currently approved greeting/topic/fallback voice clips were generated
  or retrieved and confirmed in persistent Supabase storage.
- Seven caption/alignment checks passed, TypeScript passed, and the standalone
  Node-server production build passed after a clean-cache frozen Bun install.

## Evidence and limitations

Local captures and the motion/timestamp report are under the ignored
`generated-artifacts/guide-verification/` directory in the workspace.

The standard test browser did not support WebGL, so it verified the fallback
and audio controls only. A separate real Chromium browser with SwiftShader
verified the 3D scene; its motion capture used reduced physical raster
resolution to avoid software-GPU overload. This is not a normal GPU frame-rate
benchmark or a physical-device listening assessment.

The supplied model has no facial morph targets. Audio and body gestures work;
facial lip-sync is not implemented or claimed.

Cached speech works on the external host with existing Supabase configuration.
New/changed content has a new hash: warm it from Replit before publishing, or
configure a server-side ElevenLabs provider on the external host. Details and
maintenance commands are in `knowledge/README.md`.

## Seating and short-topic update — 2026-11-05

- Rotated the chair in the same coordinate frame as the seated guide, rather
  than aiming the guide diagonally across an unrotated cushion. Calibrated both
  knees beyond the cushion lip and preserved the board/chair gap.
- Real-model geometry checks passed for initial seating, six idle samples,
  the seated greeting, return from the board, and phone framing. In these
  samples knee clearance was 7.2–8.9 cm; the lowest shoe vertex stayed within
  0.15 cm of the floor. This is sampled geometry, not a universal collision
  proof for all animations.
- A real Chromium SwiftShader browser rendered the actual scene and captured
  initial seating, walking, presenting and return-to-seat. The 390px scene was
  ready with no document overflow. Captures are in the workspace's ignored
  `generated-artifacts/guide-seating/` directory. Software rendering is not
  a physical-phone performance benchmark.
- Common topic commands now resolve deliberately, including `about`,
  `support`, `order status`, `news letter`, YouTube, experience, one-time Admin
  purchases and refunds. Static short answers are at most 55 words; the
  current catalog reply was 52 words. One-time Admin has no invented price
  or lifetime entitlement: it directs purchase enquiries to Contact.
- Browser checks covered chips and typed prompts, answer links, full board
  pagination, real Bella playback with advancing word captions, and paused
  audio time. Turning voice off cancels playback and removes its source; it
  does not depend on the HTML audio element's `muted` property.
- 56 isolated topic, caption, provider and durable-voice checks passed, along
  with TypeScript. All 35 approved replies had both public audio and caption
  metadata read back from persistent storage.
- **Browse quick answers** is real server-rendered text for visitors and
  crawlers. Static answers share the chat's approved content; pricing links
  to the live Plans page instead of embedding potentially stale amounts.
  Direct HTTP comparisons confirmed all ten static quick answers, including
  Support, exactly match the live answer endpoint after normalizing whitespace.
  Public help, plans, setup and refund information are discoverable without
  submitting chat requests. The license lookup remains `noindex`, and the
  sitemap contains public pages only, with no fabricated daily `lastmod`.
- These checks apply to the development preview. No GitHub push, Coolify
  publication, Search Console submission, or Google re-indexing was performed
  for this update. Existing published clips do not certify uncached voice
  generation on the external host.
