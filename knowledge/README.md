# ConnectLive virtual guide — knowledge base

This folder is the **only** source of product facts the homepage virtual guide
may use. If it is not written down here, the guide must say it does not know —
it never invents prices, features, device states, or payment statuses.

## Layout

- `manifest.json` — assistant identity, greeting, unknown-answer wording, and
  the allowed `emotions` / `animations` enums. The website validates every
  answer against these lists.
- `topics/*.json` — one file per subject. Each entry has:
  - `keywords` — words/phrases the local matcher scores against visitor input
  - `question` — an example of what the entry answers
  - `answer` — the complete visible reply (plain text, `\n` for line breaks)
  - `board` (optional) — a heading plus legacy short-summary metadata. The
    explanation board now displays the **complete reply**, in readable pages;
    summary lines must never replace or omit spoken words.
  - `emotion` — one of the manifest emotions
  - `animation` — one of the manifest animations (maps to a clip that actually
    exists in the rigged model)
  - `links` (optional) — site pages to offer under the answer
  - `dynamic` (optional) — `"plans"` means the answer text is composed at
    runtime from the live plan catalog (`/api/public/plans`, same reader as
    checkout). Never hard-code a price anywhere in this folder.

## Rules for editing

1. Public product facts only. Never add credentials, pairing codes, tokens,
   customer data, internal hostnames, or private roadmap items.
2. Keep answers short and plain; the chat panel is narrow.
3. When the Agent, console, pricing, or payment flow changes, update the
   matching topic file in the same change.
4. If a fact cannot be verified against the current release, do not add it —
   route the topic to the Contact page instead.
5. The guide is clearly labeled as an AI assistant; answers must not pretend
   to be a human employee.
6. The visible answer and the spoken answer must be identical. After editing
   approved content or live pricing, refresh the voice cache before publishing
   to a host without a configured speech provider.

## Voice and verification

- Speech starts only after a visitor opts in. It uses ElevenLabs Bella with a
  slower base pace, original-text word timestamps, and pause/replay controls.
- The server resolves an approved answer again before generating speech. It
  does not accept arbitrary speech text or send visitor questions to the voice
  provider. A text hash prevents an old price from being spoken as a new price.
- Voice clips and alignment metadata are content-addressed in the existing
  Supabase brand-asset bucket. Replit uses its managed connector. For uncached
  generation on Coolify, set `GUIDE_SPEECH_PROVIDER=elevenlabs` and your own
  server-only `ELEVENLABS_API_KEY`. Follow [the runtime setup](../COOLIFY.md#guide-voice-on-this-host).
  Never copy managed connector credentials to another host or use a `VITE_`
  speech key. Provider errors are not retried through a different account.
- `GUIDE_SPEECH_PROVIDER` supports `auto` (default: Replit when available,
  otherwise a direct key, otherwise cache-only), `replit`, `elevenlabs`, and
  `cache-only`. An invalid setting fails explicitly on a cache miss. Existing
  clips are readable in every mode; missing keys never invalidate them.
- Warm all approved public replies, including fixed catalog-outage wording:
  `node scripts/warm-guide-voice.cjs http://localhost:80` (from this imported
  project). Use `--only support-thanks` to check one approved entry. The script
  reads back **both** public audio and timing metadata and compares them with
  the current answer. It exits nonzero on partial writes or unreachable files.
  A live catalog outage stops the pricing check rather than certifying stale
  prices. A cache hit is not proof that new generation works.
- Editing approved text changes its hash automatically; the next request
  creates a new clip with the selected provider. A fresh server process reads
  that clip from Supabase without another provider charge. Do not clear the
  existing bucket or change prices just to test generation.
- Speech requests accept only an approved answer ID and its current hash,
  never free-form text. Request limits remain 20 speech / 30 answer requests
  per minute per process-local client bucket. New generations are separately
  limited to 3 concurrent and 40 per hour per process, with same-hash requests
  coalesced. These are not a distributed quota; set a provider credit limit.
- Missing keys, provider failures, invalid audio/timing, and changed hashes
  produce a clear listening error while the written answer stays available.
  If durable storage fails after generation, real audio can play for that
  visit with a visible warning, but is never reported as a persistent clip.
- Run isolated checks without provider charges or database changes:
  `node --test scripts/guide-content-check.cjs scripts/guide-speech-check.cjs scripts/warm-guide-voice-check.cjs`.
- For an explicitly authorized **real provider** check, run
  `node scripts/verify-guide-voice-live.cjs elevenlabs --confirm-charge` from
  this source checkout with dependencies and server secrets configured.
  It generates one punctuation-only revision of a trusted answer in an
  isolated in-memory fixture, persists audio/captions under unique temporary
  paths in the existing bucket, checks a fresh cache-only worker, then removes
  only its own test objects. It does not edit knowledge files or prices.
  Use `replit` instead of `elevenlabs` to test the managed connection; that
  does **not** certify the external host's key or configuration.
- Section events use bounded, allowlisted properties only: topic IDs, phases,
  pages, timing and error categories. No question text, account details or
  persistent visitor identifiers are logged by guide tracking. DNT/GPC opt out.
- The on-page Experience status panel reports rendering, movement, voice,
  board page and source. Reduced-motion/no-WebGL visitors keep readable
  captions and the full text/voice controls with a still-image fallback.
