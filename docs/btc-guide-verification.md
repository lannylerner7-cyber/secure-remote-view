# BTC checkout, automatic guide and media review

Development-source update, 2026-11-05. No GitHub push, Coolify publication, real
payment, real wallet replacement or plan-price change was performed.

## Head-to-head review

| Before | Now |
| --- | --- |
| Separate Listen, Play/Pause and Replay actions for the guide | Input starts a reply automatically; new input replaces old audio. Sound off and browser-permission recovery remain available. |
| Optional hero WebGL initialized as soon as its above-the-fold observer fired | Poster/page loads first; model initialization is deferred until after load and idle time. |
| Footer mounted a WebGL capability probe during initial hydration | Probe waits until the footer is near the viewport. |
| Both promotional videos had `src` and `autoPlay` at initial render | No source until visible or requested; offscreen/hidden clips stop. |
| YouTube iframe autoplayed when the browser's lazy-loading threshold was reached | A thumbnail/button loads the player only on click. |
| New checkout advertised BTC/USDT/USDC | Client, server validation, metadata, FAQ and guide answer agree on Bitcoin mainnet only. |
| Wallet input checked only length | Mainnet/checksum validation, normalized Bech32 casing and stale-edit protection. |
| Payment panel demanded three wallets and Coinbase configuration | Only the BTC wallet is required; monitor authorization is described separately from scheduler health. |
| External QR service received the address; QR had no amount | Local SVG QR uses the invoice's exact BTC amount and full order reference. |
| Expired invoice said “refresh to recalculate” and retained payment controls | No silent repricing; payment controls are removed and a new invoice/support path is offered. |
| A paid order appeared as access delivered | Access is available only when its link actually exists. Payment confirmation is separate. |
| Chain API errors became an empty transaction list | Errors are surfaced as unavailable; affected pending orders are not expired. |
| Shared wallet queried once for each pending invoice | One history request per asset/address per reconciliation run; exact native-unit matching retained. |
| Any authenticated user could call payment health's service-role reader | Explicit payment-admin role enforcement precedes that read and order/totals reads. |

## Asset inventory and measurement boundary

Public guide assets responded successfully to read-only size checks:

| Asset | Bytes |
| --- | ---: |
| Character GLB | 1,018,072 |
| Chair GLB | 2,067,816 |
| Board GLB | 1,555,424 |
| Seated WebP fallback | 55,664 |
| All three GLBs | 4,641,312 |
| Promotional “side by side” WebM | 517,095 |
| Promotional document-input WebM | 5,526,611 |
| Both promotional WebMs | 6,043,706 |

This update changes **when** media loads, not these model byte sizes. No model
geometry, seating calibration, animations or textures were rewritten. The user
accepted the current seating. Cold loading the footer can still require about
4.64 MB of model downloads and GPU/CPU setup.
The two promotional clips total about 6.04 MB; they no longer receive a video
source at initial render. YouTube's player/downloads also wait for a click.

The public preview `/order` returned HTTP 200 and the new Bitcoin wording, with
about 0.365 seconds to first byte in one warm read. This is **not** a before/after
benchmark, a production LCP measurement or a physical-phone performance claim.
Vite's development module traffic is not the production bundle.

## Automated checks

- 25 isolated Bitcoin checks exercise actual server handlers and helpers with
  in-memory database/provider boundaries: new-asset rejection, valid/invalid
  addresses, BIP21/native units, wallet save/read-back and concurrency, historical
  invoice preservation, roles, health, audit warnings, manual confirmation and
  chain failure/confirmation behavior. Reconciler checks cover authorization,
  no expiry during an outage, rejection of old same-amount transactions, and
  shared-wallet fetch reuse without adjacent-quote collisions.
- 56 existing guide topic/caption/provider/durable-voice checks passed.
- 15 existing exact-payment-identity checks passed, including historical
  stablecoin precision.
- 21 cache/replica/streaming checks passed with BTC-only quote fetching.
- Monthly plan/canonical catalog checks passed with four isolated BTC quotes;
  previously issued quote values remain unchanged.
- TypeScript passed.
- All explicit production-lock package URLs passed the credential-free public
  HTTPS-host check. New package integrity/version values are retained.
- The changed `pay-how` approved reply was regenerated/read back from persistent
  voice storage: 41 words, approximately 17.5 seconds, audio plus word timing.
  This does not certify uncached generation on the external host.

Database and chain behavior in isolated tests is not a real transfer, production
database migration, cryptographic wallet-ownership proof or SMTP inbox check.

## Browser and build evidence

- A clean-cache **Bun 1.3.6 frozen install and Node-server production build**
  passed in an isolated directory with no project secrets. Only dummy public
  build settings were supplied. The final responsive-layout edits also passed
  a production rebuild using those frozen dependencies. This is not a Coolify
  container deployment.
- The preview screenshot confirmed the buyer page renders the new BTC-only
  wording and current plans without a page-breaking browser error.
- A fresh browser context reached the real payment sign-in and signed in with
  a disposable super-admin. The wallet and monitor-authorization configuration
  were present. This checks configuration, **not wallet ownership or a running
  payment scheduler**. The initial stale/static-preview observation was not a
  defect in the current authentication implementation.
- Wallet checks passed for an invalid address, a valid unsaved draft, replacement
  confirmation/cancel, and discard. The draft QR's actual rendered pixels decoded
  to the matching Bitcoin URI.
- Wallet save was tested **only with intercepted synthetic responses**: request
  fields included BTC, the address and the expected previous address; successful
  read-back showed the new synthetic address/QR, and an audit warning remained
  visibly distinct from a clean save. No real wallet save was attempted.
- The buyer's plan/contact steps and mandatory terms were checked without
  creating an invoice. Isolated invoice fixtures covered pending, detected,
  expired, cancelled, refunded, paid-without-access and legacy USDT states.
  Expired/settled states removed active payment controls; paid without an access
  link correctly kept access delivery waiting.
- The invoice QR's rendered pixels decoded to the **exact 0.00100001 BTC amount,
  matching fixture address and full CL reference**. No external QR-service
  request was observed. The legacy fixture did not offer a Bitcoin wallet link.
- Wallet and invoice layouts passed at 390px. Orders initially caused document
  overflow despite a working inner table scroller. An isolated browser check
  measured the repair at **390px client width / 390px scroll width**, while the
  table retained **356px client width / 920px internal scroll width**. The same
  tested layout/paint containment is applied to the table wrapper in source.
- The disposable account and license were removed after payment checks. No real
  customer order, receiving-wallet setting or plan price was changed.

### Homepage browser evidence

- A fresh browser captured navigation/load plus approximately three seconds
  before scrolling. No WebM, MP4, GLB or YouTube/player request occurred, promo
  videos had no source, and no player iframe was present. The small guide
  portrait WebP was allowed. This is resource-gating evidence, **not a measured
  before/after speed score**.
- On entering the guide, the greeting and board text appeared with the audio
  paused at zero and no source. No guide Play/Pause/Replay controls were present.
- A known answer began playing without a separate playback action. Actual media
  time and caption indices advanced: About reached 9.13/14.26 seconds at word 19,
  then completed at word 28. Answer and speech requests returned HTTP 200.
- Submitting Order status during active Pricing speech stopped/reset the old
  audio, replaced the answer and automatically spoke the new reply. The new clip
  reached 8.30/10.54 seconds with caption word 25.
- With Sound off, a subsequent Agent setup question still received a text answer.
  Audio remained paused at zero with no source attribute and no new speech
  request. A stale browser `currentSrc` value was not mistaken for playback.
- At 390px viewport width, document client/scroll widths both measured 375px
  (15px was the vertical scrollbar). Guide/chat/message widths fit; board text
  was 16px and wrapped without document-level horizontal overflow.
- This browser used the supported still-portrait fallback. It did **not** verify
  genuine 3D rendering, new seating geometry, physical-phone autoplay behavior
  or sound quality by listening. Seating geometry was intentionally unchanged.
  No permission-recovery prompt was needed in this run.

## Remaining boundaries

- The live wallet and deployed scheduler must be configured/verified by an
  authorized operator. No seed phrase, private key or real test payment was
  requested.
- Existing invoices and legacy webhook handling remain intact. Bitcoin-only
  applies to **new** checkout; historical rows are not deleted or converted.
- The recent-history scanner still has a 25-transaction window and a 200-order
  batch; high-volume completeness and late-payment review are roadmap items.
- Wallet/manual-paid writes disclose audit failures, but are not an atomic
  financial/audit database transaction.
- Email-based license lookup must not be considered ownership verification.
  A verified recovery flow is an explicit high-priority roadmap item.
- No production crawl, Google submission, physical-device benchmark, Windows
  media session, native packaging or external Android build was performed.

See [the complete feature roadmap](feature-roadmap.md) for all 32 guide topics,
the separately advertised product features, and proposed additions with concrete
acceptance criteria.
