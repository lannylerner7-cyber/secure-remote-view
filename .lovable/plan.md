# Roadmap ↔ Codebase Audit — findings and remediation

A head-to-head pass over `PROJECT-MAP.md` (2033 lines) against the web app,
`agent/src` (28 files) and `admin/src` (42 files).

## Verdict

The roadmap is honest. Every item tagged SHIPPED/closed resolves to real code
on disk. No fabricated features, no ghost routes, no stale domains, no
`AGENT_DEPLOYMENT_KEY`, no `ConsentPrompt` leftovers, zero TODO/FIXME across
all three peers. The old `$250 / $570 / $840` figures still in the page source
are the intentional strikethrough "was" prices for the promo, not stale copy.

Cross-peer parity is complete: clipboard, file transfer, monitor picker,
recording, input datachannel, ICE/TURN and telemetry all exist on every peer
that needs them. The only asymmetries are deliberate (WEBM on web vs IVF on
native, agent as capture source rather than consumer).

## What is genuinely wrong — documentation drift (4 fixes)

1. **Stale consent paragraph.** The "Consent policy change" entry (~line 1502)
   still describes a registry-gated `ConsentPrompt.AskAsync` dialog behind
   `HKCU\Software\ConnectLive\PromptOnConnect`. §10.28 deleted that file
   outright. A reader following the doc top-down would believe the dialog
   exists. Mark superseded, pointing at §10.28.
2. **System map still draws `ConsentPrompt.cs`.** The ASCII diagram in §2 lists
   it as an agent component. Remove that node.
3. **§4 invariant "Consent is a click, not a default."** No longer true on the
   agent — authorisation is now account-level via Meeting-ID enrollment and
   enforced server-side; the route still owns the `invited → active`
   transition. Rewrite the invariant to state the real model rather than the
   retired one.
4. **§10.9 status board is superseded** and never rolled forward past S18–S28;
   the same is true of the "Still outstanding" footers in §10.19 and §10.21
   (S21's files health tile was in fact closed later in §10.22). Add a
   one-line "superseded by §10.2x" marker on each so the doc's own status
   table stops contradicting its tail.

## What is missing — code, and it matches what the doc already admits

| Gap | State |
| --- | --- |
| S3 fleet verification | Needs a live Windows fleet — not buildable here |
| S17 phase 3 hardware H.264 | `HwH264Encoder.cs` absent; `CodecPolicy.AllowH264` is a switch with no consumer |
| S18 real 4K latency numbers | Instrumentation shipped, no reading taken |
| S20 present pacing / vsync | No `CompositionTarget.Rendering` pacing loop in `admin/src/Media` |
| S24 recording retention/upload | Only local write (`IvfWriter`) + browser download; no server retention |
| S25 signing certificate | `tools/CodeSign.ps1` ready, purchase is procurement |
| §10.29 background-motion pass | The homepage motion re-layer shipped last turn is not logged in the roadmap at all |

## Proposed work in this pass

Documentation-only, plus one new changelog section:

- Fix items 1–4 above in `PROJECT-MAP.md`.
- Add §10.29 logging the homepage motion re-layer (`cl-mesh`, `cl-grid-pan`,
  `cl-sheen`, `cl-drift-slow`, z-index restacking) that shipped but was never
  recorded.
- Add a single consolidated "Open items" table at the end so the true
  remaining state is readable in one place instead of assembled from footers.

No source files change. S20 pacing and S24 retention are the two remaining
gaps that are actually buildable here — say the word and I take S20 next.

## Technical notes

Verified with: full-tree grep for stale identifiers across `src`, `agent/src`,
`admin/src`; route-target resolution for every `Link`/`navigate()` against
`src/routeTree.gen.ts`; file-level existence checks for every claimed artefact
in §9.x and §10.x; `consented` legacy-state filters confirmed still present in
`heartbeat.ts` and `admin/src/Api/ApiClient.cs` per the §4 invariant.
