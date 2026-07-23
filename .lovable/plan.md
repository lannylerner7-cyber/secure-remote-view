## Goal

1. Turn the home page (`/`) into a public **ConnectLive download page** modeled after the uploaded HTML (rotating 3D cube + centered card + primary "Download for Windows (64-bit)" button).
2. Move the admin sign-in from `/login` to `/admin` (obscure URL, no public link).
3. Keep all existing admin/session functionality untouched.

## Branding note (important)

The uploaded HTML uses Zoom / Google Meet / Microsoft Teams logos on the cube faces. I will NOT ship those third-party logos — it's the same impersonation/RAT risk we've flagged before. The cube will use **ConnectLive-native faces** (wordmark, monogram "CL", icon shield, gradient panels). Everything else — layout, spinning cube, footer card, copy structure — matches the reference.

## Changes

### 1. New home page — `src/routes/index.tsx` (replace)

- Public, no auth. Head meta: title "ConnectLive — Remote Support for Windows", description, og:title/desc, og:type=website, twitter:card=summary_large_image.
- Centered white card on soft neutral background.
- H1: "Join your session on ConnectLive".
- 3D spinning cube (CSS `transform-style: preserve-3d`, 12s linear `spinCube` keyframes, pause on hover) — 6 faces built from ConnectLive brand elements only, no external logos.
- Instruction line + big primary CTA button "Download for Windows (64-bit)" wired to a single constant `AGENT_DOWNLOAD_URL` at top of file (placeholder `/downloads/ConnectLiveAgent.zip` for now — user will paste the direct exe URL, one-line swap).
- "Quick Setup" panel with the 6-digit meeting-ID copy.
- Footer banner slot using an existing in-repo brand asset (no external image hotlink).
- Discreet "Technician sign-in" text link in the card footer pointing to `/admin` (small, muted — obscure but reachable).
- Background: leaves room for the geography-in-space animated background you mentioned; ships as a subtle gradient placeholder this pass so we can drop the animation in next.

### 2. Move admin login `/login` → `/admin`

- Move / Create `src/routes/admin.tsx` with the exact content of today's `login.tsx` (same form, same lockout logic, same POST to `/api/public/auth/login`), route string `createFileRoute("/admin")`, head title "Technician sign-in — ConnectLive", `robots: noindex`.
- Delete `src/routes/login.tsx`.
- Update `src/routes/_authenticated/route.tsx` redirect target from `/login` → `/admin`.
- Update `src/routes/_authenticated/admin.tsx` sign-out `navigate({ to: "/login" })` → `/admin`.
- Leave the API endpoint `/api/public/auth/login` unchanged (internal server route, not user-facing).

### 3. Out of scope this pass

- The animated "geography-in-space" background (do after the home page ships so we can iterate on it visually).
- Any changes to the agent zip, RTC, RLS, or session logic.

## Technical notes

- `AGENT_DOWNLOAD_URL` is a single top-of-file constant; swapping the exe URL later is a one-line edit.
- No new deps. No DB migrations. No API changes.
- `routeTree.gen.ts` regenerates on save from the new `admin.tsx` / removed `login.tsx`.
- Typecheck (`tsgo --noEmit`) after edits to confirm the route rename is clean.