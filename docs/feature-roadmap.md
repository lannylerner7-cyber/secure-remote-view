# ConnectLive — feature breakdown and roadmap

Updated 2026-11-05. This is an evidence-based inventory, not a claim that every
advertised feature has passed a real-device test.

## Status key

- **Checked in this update:** changed web behavior tested in isolation and/or in
  the preview. See [verification](btc-guide-verification.md) for the exact boundary.
- **Existing implementation:** source exists; this update did not certify its
  native-device or production behavior.
- **Policy / manual process:** a commercial statement or team-operated service,
  not an automated feature.
- **Proposed:** not implemented by this update.

The web technician console, native Windows Admin, Windows Agent and payment
administration are different products/surfaces. Android work may exist outside
this checkout; absence here is not evidence that development has not started.

For the requested Agent-specific gaps, see the
[remote-access Agent breakdown](agent-feature-breakdown.md):
18 existing capabilities, nine missing/unsupported extensions, and a separate
Windows acceptance checklist. These are not homepage-guide features.

## 1. Work requested in this update

| Requirement | What it means now | Boundary |
| --- | --- | --- |
| Automatic guide replies | Submitting a question or selecting a topic requests a written and spoken reply. There are no Play/Pause/Replay buttons. New input cancels the previous reply. | No unsolicited audio on page load. Sound off remains available. A browser may require an explicit sound-permission gesture. |
| Complete explanation board | The full approved answer is paginated; word highlighting follows actual speech timing. | Text remains available without audio or WebGL. Paging follows speech while it plays. |
| Faster initial media loading | Promotional video sources wait until visible; videos stop offscreen. YouTube loads on click. Optional hero 3D waits until initial load and idle time; the footer's WebGL check waits until nearby. | Model bytes were not compressed again. Device/GPU and published-site performance still need separate measurements. |
| Standard BTC checkout | New order validation and UI accept Bitcoin mainnet only. | No discounts or plan-price changes. Not Lightning, wrapped BTC, stablecoins or a custodial payment account. |
| Receiving wallet administration | Super-admin sets a checksum-validated mainnet receiving address, previews its QR, and confirms replacements. Stale edits are rejected. | Never enter a private key or seed phrase. Existing invoices retain their address. No live wallet was changed for this review. |
| Invoice QR | Generated locally from the invoice address, exact eight-decimal BTC amount and full order reference, using BIP21. | No third-party QR endpoint. The reference is a wallet label/support identifier, not a required blockchain memo. |
| Safe invoice states | Payment controls disappear for detected, paid, expired, refunded and cancelled invoices. Payment confirmation and access availability are distinct. | Expiry never silently reprices an existing invoice. Late payments require review. |
| Neutral payment admin | Neutral order, wallet and health views; readable loading, empty, refresh and error states; explicit manual-paid confirmation. | Existing customer/email administration is retained. No new refund automation or pricing editor was invented. |
| BTC monitoring honesty | Configuration no longer requires Coinbase keys. Blockchain failures cannot masquerade as empty history and expire an order. Shared-address lookups are reused per run. | A configured authorization token does not prove that the deployed scheduler runs. A real chain payment was not sent. |
| Preserve historical payments | Legacy invoices, events and orders remain readable; their original asset, amount and address are not rewritten. | Only new checkout and wallet configuration are BTC-only. Existing legacy webhook handling is not deleted. |

## 2. Every topic currently listed by the guide

The guide has **32 topic entries**, plus its greeting, unknown-answer response
and catalog-unavailable response. These are approved answers, not 35 independent
implemented product capabilities. Topic/caption tests verify the answer system;
they do not prove the underlying Windows features or team service commitments.

| Topic / ID | Accurate scope | Evidence / remaining gate |
| --- | --- | --- |
| What is ConnectLive? — `about-what` | Remote support for authorized Windows devices, through an Agent and technician console. | Existing implementation. Full native session verification is separate. |
| Security — `about-security` | Enrollment, permissions, encrypted transport and reviewable sessions. | Existing enforcement source; not a blanket security certification. Real Windows grant/withdrawal/transport gates remain. |
| Human or AI? — `about-who` | A clearly labelled AI guide, not a human support operator. | The answer system uses approved local content; it is not an unrestricted support agent. |
| Audit reports — `audit-reports` | Session/accountability records, with advertised plan-specific history. | Audit UI/source exists. Verify deployed retention/purge policy and exports before promising enforcement. |
| Technician console — `admin-console` | Role-gated device administration and authorized sessions. | Existing web console. It is not the payment console or a newly built device roster. |
| Session recording — `admin-recording` | Recording is advertised as optional on Starter and included on higher plans. | Recording code exists. Validate permission, storage, playback and plan entitlement on an authorized real session. |
| Enrollment — `enroll-how` | Generate a pairing code in the technician console and enter it in the Windows Agent. | Existing implementation; native first-run/reconnect tests require Windows. |
| Meeting ID — `enroll-meeting-id` | Workspace identification is part of delivery/enrollment, distinct from a short pairing code. | Existing setup flow. Never collect IDs, credentials or pairing codes in guide chat. |
| Device allowance — `enroll-seats` | Starter 10, Team 20, Business 50; Enterprise by agreement. | Catalog/plan tests cover listed limits. Real concurrent enrollment enforcement is a separate gate. |
| Getting started — `start-how` | Order, payment, delivery, installation and enrollment. | Ordering changes checked here. Provisioning and first support session are not automatically certified by a paid invoice. |
| Platforms — `start-requirements` | The repository's supported native baseline is Windows. | Do not claim a working Android APK, macOS or Linux Agent from this source. Confirm external Android work with its owner. |
| Delivery time — `start-delivery` | Team-operated delivery normally within 24–48 business hours. | Policy/manual process, not an automated delivery SLA or inbox-delivery proof. |
| Place an order — `order-start` | Choose a live plan, enter contact details and create an invoice. | BTC-only validation and quote snapshots checked; no real buyer order was needed for these tests. |
| Payment — `pay-how` | Bitcoin mainnet only for new orders, exact-amount QR, 15-minute price lock. | Changed answer and its new voice clip verified. Real money/scheduler verification remains separate. |
| Exact amount — `pay-exact` | Shared-wallet matching uses an exact, unique native-unit quote. | Exact satoshi comparisons retained. Disclosed matching adjustment can be up to 99 satoshis; never round or subtract fees. |
| Order status — `pay-status` | Open the invoice or use the tracking page; the guide cannot query a visitor's private order. | Public guide remains fact-only. Ownership protection for email-based recovery needs its own review below. |
| Operator limits — `perm-operators` | Role and workspace permission boundaries. | Existing implementation. Broader organization/multi-team management is not assumed to be a complete self-service product. |
| Curtain mode — `perm-curtain` | A session privacy state controlled through the technician workflow. | Native curtain source exists. Verify exactly what the local user and remote operator see on Windows before broader privacy promises. |
| Visible sessions — `perm-indication` | Support must remain authorized and locally visible/reviewable. | A standing product requirement, not proof of native UI visibility from a Linux build or static screenshot. |
| Plans and pricing — `plans-list` | Prices are read from the current catalog; marketing and new quotes use the same reader. | Catalog parity checked. No prices were changed. Existing invoice amounts remain locked. |
| One-time Admin — `plans-one-time-admin` | A one-time purchase enquiry, not initial setup or monthly billing. | No approved amount, license term, support/update term or checkout offer yet. Contact-only. |
| Change plans — `plans-change` | Team-assisted tier changes, without repricing existing invoices. | Policy/manual process. A self-service subscription-management system was not added. |
| Enterprise — `plans-enterprise` | Custom commercial/deployment agreement. | Contact-only; no invented public price or automatic unlimited entitlement. |
| Human support — `support-contact` | Contact page and reference-based help. | Existing contact/email paths; SMTP acceptance is not proof of inbox delivery or support response time. |
| Thanks — `support-thanks` | A short conversational acknowledgement. | Approved-answer behavior, not an additional feature. |
| Offline device help — `ts-offline` | Basic checks for power, network, enrollment, capacity and firewall. | Advice only; the guide cannot see the device or diagnose its live state. |
| Stuck/black video — `ts-video` | Troubleshooting guidance and escalation with Agent/Windows versions. | Not an automatic repair. JPEG/cursor movement does not prove fresh WebRTC video. |
| Sign-in help — `ts-credentials` | Route lost credentials to the team for ownership verification. | No credentials collected or reset by the guide. |
| Newsletter — `site-newsletter` | Field notes signup and unsubscribe. | Existing implementation. This update did not send campaigns or recertify delivery. |
| YouTube — `site-youtube` | The public setup walkthrough. | Player now loads only when requested; no claim of a live remote session. |
| Experience preview — `site-experience` | Homepage console demonstrations and setup material. | Demonstrations, not a connection to the visitor's device. Generic interaction clips are not ConnectLive performance evidence. |
| Refunds — `support-refund` | Seven-day policy subject to terms; contact from the order email with the reference. | Policy/manual review. The refund state is displayable, but an automated on-chain refund workflow was not added. |

## 3. Product features shown elsewhere on the website

| Listed feature | Existing pieces | What must be proved before a broader claim |
| --- | --- | --- |
| Device presence and inventory | Web device tables, native clients, pairing and last-seen state. | Online/offline accuracy, authorization and recovery with real Agents. |
| WebRTC video | Browser/native media and signaling source, TURN configuration. | Fresh decoded frames, first connection, reconnect and recovery on designated Windows hardware. |
| Frame fallback | JPEG/HTTPS fallback and frame-recovery source. | Visible fresh frames and bounded latency; do not use this as proof of WebRTC health. |
| Mouse/keyboard control | Input handlers and granted control scope. | Correct targeting, grant enforcement and immediate withdrawal on real Windows. |
| Clipboard | Native relay and permission scope. | Bidirectional authorized transfer, encoding/size limits and withdrawal. |
| Files | Native transfer and web session-file panel. | Upload/download completion, ownership, checksums, expiry/quota and interruption handling. |
| Privacy curtain | Native controller/overlay and session state. | Local versus remote behavior, multi-monitor edge cases and reliable removal. |
| Recording | Recording UI, permissions and storage paths. | Start/stop, playback, retention, entitlement, deletion and device withdrawal. |
| Power actions | Power relay and console menu. | Separate explicit scope, OS permissions, correct device and safe recovery. Existing screen-control consent is not enough. |
| Audit trail | Audit panel, events and reports. | Event completeness, role restrictions, exports and deployed retention. |
| Multi-operator/team plans | Advertised operator allowances and role source. | Define team boundaries, concurrent-session behavior and actual entitlement enforcement. |
| Setup videos/support/onboarding | Public setup walkthrough and team contact/delivery processes. | Current installation instructions, successful deliveries and operational service coverage. |
| Windows packages and native Admin | Existing Windows build/packaging source. | Build/install/upgrade/signing and actual media/input parity on Windows. Do not retire native Admin without measured parity and approval. |
| Android Agent | Shared platform groundwork; user reports external work in progress. | Obtain that source/build and test Android-specific consent, capture and input; do not label it finished or not started from this checkout alone. |

Source landmarks: `src/components/console/`, `src/lib/orders.functions.ts`,
`src/routes/order.$id.tsx`, `src/shared/payment-identity.ts`,
`agent/src/{AuthorizationGrant,ClipboardRelay,FileTransfer,CurtainController,PowerRelay}.cs`.
The older Android-specific roadmap remains historical context, not this inventory's
completion checklist.

## 4. Additional features worth considering — not implemented

Priority orders the proposed work; it does not authorize implementation or a live
configuration change. The acceptance criteria keep each idea independently testable.

| Priority | Proposal | Breakdown / acceptance criteria | Dependency |
| --- | --- | --- | --- |
| P0 | Payment-monitor heartbeat | Record each run's start, result, checked orders and last success; show stale/error status; alert the operator without exposing credentials. | Real deployed scheduler configuration and controlled test payment. |
| P0 | Ownership-verified license recovery | Do not return private order/access details based only on knowing an email. Add a short-lived, single-use recovery link and uniform public response; test expiry/reuse/rate limits. | Agreed email/account verification flow. Current email-only lookup must not be treated as ownership proof. |
| P0 | Payment exception review | Queue late, underpaid, overpaid, duplicate and unmatched transfers; show evidence; require an audited decision; never automatically credit a near-match. | Exact satoshi identity and a defined settlement policy. |
| P0 | Transactional financial audit | Commit wallet changes/manual-paid changes and their audit events together; handle stale edits and retry idempotency. | Additive database design/release review. Current code discloses partial audit failures; it is not an atomic transaction. |
| P1 | Higher-volume chain reconciliation | Paginate beyond the current recent-25-transaction lookup, follow known transaction IDs, prevent batch starvation, and preserve reorg/retry evidence. | Tests with a busy shared wallet and bounded provider limits. |
| P1 | Checkout abuse protection | Bound order creation and confirmation-email volume; add idempotent submit keys; test retries, burst traffic and privacy-safe logging. | Agreed limits and a shared/distributed limiter for multiple server processes. |
| P1 | Wallet ownership/rotation assurance | Confirm address control through an agreed process; optionally require a second authorized approval for rotation. Keep old invoice destinations immutable. | Public-address-only policy; never request seed phrases/private keys. |
| P1 | Real site load budget | Measure published cold/warm loads and a physical phone; track LCP/INP, transferred bytes and long tasks. Resize/recompress the largest furniture textures if quality holds. | Approved visual quality target and actual deployed performance samples. |
| P1 | First-party product demonstrations | Replace generic interaction clips with recordings of an authorized ConnectLive session, including reconnect and degraded-network behavior. | Consenting test devices and redacted customer/credential information. |
| P1 | One-time Admin offer | Specify purchase amount, included users/devices, update/support terms, refund rules and license duration; then add a distinct offer. | Owner-approved commercial terms. Monthly plans must remain separate. |
| P1 | Refund operations | Reviewed requests, eligibility evidence, destination validation, fee/rate disclosure, audit and customer notices; distinguish submitted from chain-confirmed refunds. | Approved refund policy and a secure operator-controlled signing process. |
| P2 | Automatic read-only help updates | Revalidate approved guide claims against product releases; queue content for review and refresh only changed voice clips. | Named content owner and release acceptance gates. No unrestricted feature claims. |
| P2 | More accessible/multilingual guidance | Keyboard/screen-reader review, a persistent sound preference and approved translated text/audio with matching captions. | Approved translations/voices and real-device accessibility testing. |
| P2 | Organization management | Self-service team membership, operator scope, concurrent-session policy and plan entitlement visibility. | A clear permission model; must not weaken device authorization. |
| P2 | Per-order BTC addresses | Explore a watch-only address-derivation or invoice service, while keeping signing keys outside the app. Eliminate reliance on unique amount adjustments. | Explicit wallet architecture decision; not part of standard single-address configuration. |

## 5. Release gates

1. The owner confirms the currently configured BTC mainnet receiving address, or
   replaces it through the super-admin Wallet tab, and confirms control of the
   wallet outside the app. Address validation is not ownership verification.
   Never use a test-vector address for money.
2. Confirm the saved QR against that address and a new invoice's exact amount.
3. Publish the reviewed source through the existing GitHub/Coolify process; no
   automatic publish was requested or performed here.
4. Verify deployed scheduler calls and a deliberately authorized real payment,
   confirmations, invoice state and delivery outcome. Do not declare this gate
   passed from fixture tests.
5. Confirm production search-visible wording and measure production loading;
   preview changes do not establish Google indexing or production performance.
6. Keep native-device/Android gates separate from the web release. No Windows
   or Android session was implicitly authorized by this payment/guide request.
