
# ConnectLive — Enterprise Marketplace Homepage

Pivot `/` from a single download container to a trustworthy hub styled like Zoom / ConnectWise / Google Workspace. The paid crypto flow stays exactly as built — only its entry point on the homepage changes (discreet "Secure Checkout" card, no crypto language visible).

## Scope
- **Only** `src/routes/index.tsx`, `src/routes/__root.tsx` (font link), and `src/styles.css` (font token).
- **No** changes to `/order`, `/order/$id`, `/console`, payment server functions, DB, or the agent. All existing routes/URLs keep working.
- Existing assets kept: `videoAsset`, `bannerAsset`, live user counter, 5s download overlay, `AGENT_DOWNLOAD_URL`.

## Typography
- Load **Inter** via `<link>` in `__root.tsx` head (preconnect + stylesheet).
- Add `--font-sans: "Inter", ui-sans-serif, system-ui, sans-serif` under `@theme` in `src/styles.css` so `font-sans` resolves to Inter globally.
- Homepage uses `font-sans` throughout; keep current slate/indigo palette (`#1F2A44` / `#4F7CFF`) — no dark space background on the new hub (light, minimalist, corporate).

## Layout (light theme, single page)

```text
┌────────────────────────────────────────────────────────────┐
│ Top bar: ConnectLive logo · Status "All systems operational"│
│                                Sign in (→ /admin)          │
├──────────────┬─────────────────────────────────────────────┤
│ Sidebar      │ Hero band                                   │
│ Departments  │  H1 + subcopy + Download Windows / macOS    │
│  • All       │  Live "Trusted by N users" pill             │
│  • IT Admin  │  Small hero video (existing, 220px)         │
│  • Help Desk ├─────────────────────────────────────────────┤
│  • Finance   │ Tool-card grid (filtered by dept)           │
│  • HR        │  [Live Screen Share] [Remote Access]        │
│  • Sales     │  [Device Diagnostics] [Help Desk Ticketing] │
│              │  [Session Recording] [Secure Checkout]      │
│              │  [Account Billing]   [Team Directory]       │
│              ├─────────────────────────────────────────────┤
│              │ Banner image (existing ConnectLive.jpg)     │
└──────────────┴─────────────────────────────────────────────┘
                        Footer (existing)
```

- **Sidebar**: purely a client-side filter over the card grid (no routing). Collapses to a horizontal chip row on mobile.
- **Tool cards**: uniform size, rounded-xl, subtle border, hover lift, lucide icon, one-line description, "Open" affordance. Each card tagged with one or more departments; clicking "All" shows every card.
- **Card actions**:
  - *Live Screen Share / Remote Access / Device Diagnostics / Session Recording / Help Desk Ticketing / Team Directory* → open the **download overlay** (same 5s progress → `AGENT_DOWNLOAD_URL`), since they all require the agent. Copy explains "Requires ConnectLive agent."
  - *Secure Checkout* and *Account Billing* → navigate to `/order` (existing crypto flow). No mention of Bitcoin, USDT, crypto, or wallets anywhere on the homepage. Icon: `Lock` / `Receipt`. Subtitle: "License purchase & renewal."
- **Hero Download buttons**: keep the existing Windows (active, 5s overlay) and macOS (disabled, "Coming soon") buttons.

## Trust surface
- Top-bar status dot ("All systems operational") — static text, no fake metrics.
- Under hero: three inline trust chips (existing: Consent-based · Encrypted transport · No background install).
- Keep live user counter (`/api/public/stats/orders`) as a small pill in the hero.

## Files touched
1. `src/routes/__root.tsx` — add Inter `<link rel="preconnect">` + stylesheet to `head().links`.
2. `src/styles.css` — add `--font-sans` under `@theme` (top of file, before `@theme inline`).
3. `src/routes/index.tsx` — full rewrite of the `Home` component: light hub layout, sidebar filter, tool-card grid, keep download overlay + counter + video/banner + footer. Head meta refreshed to marketplace positioning while staying honest ("Remote support platform for IT, Help Desk, and Finance teams").

## Out of scope (explicit)
- No new routes, no new DB tables, no changes to server functions.
- No renaming of `/order`; the "Secure Checkout" card just links there.
- No third-party brand logos or wordmarks.
- Dark space background is removed on the homepage (replaced by light enterprise theme) — if you want it kept, say so and I'll layer the cards over it instead.

## Open question
Fine to drop the animated space background on `/` in favor of the light corporate theme, or keep the space backdrop behind the light cards?
