## Goal
Replace the default Lovable favicon (`public/favicon.ico`) with a custom, on-brand ConnectLive favicon so browser tabs and bookmarks show our own identity.

## What we know
- `src/routes/__root.tsx` currently links `{ rel: "icon", href: "/favicon.ico", type: "image/x-icon" }`.
- `public/favicon.ico` exists and is the Lovable default.
- Brand palette is navy/moonstone (`#1F2A44`, `#4F7CFF`) with an Inter typeface.
- User chose an **abstract node/eye** concept for the mark.

## Plan
1. **Generate the favicon**
   - Use the agent-side image generator to create a 512×512 PNG favicon:
     - Concept: abstract node/eye (transparency/vision motif)
     - Palette: deep navy background (`#1F2A44`) with moonstone/blue accent (`#4F7CFF`)
     - Style: minimal, flat, readable at 16×16 px
   - Save to `public/favicon.png`.

2. **Wire it into the app**
   - Update `src/routes/__root.tsx` head `links`:
     - Replace the `/favicon.ico` entry with `/favicon.png` (`type: "image/png"`).
   - Delete the old `public/favicon.ico` so crawlers/clients don’t keep serving the Lovable icon.

3. **Verify**
   - Run a quick build check to ensure no broken links.
   - Optionally load the preview and confirm the new favicon appears in the browser tab.

## Deliverable
A custom ConnectLive favicon served from `/favicon.png`, referenced in the root route, with the old Lovable icon removed.