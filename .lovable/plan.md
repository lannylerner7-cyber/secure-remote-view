## Change

Edit `src/routes/index.tsx` only. No other files touched.

### 1. Upload the two user assets to Lovable CDN
- `user-uploads://ConnectLive.MP4` → `src/assets/connectlive.mp4.asset.json`
- `user-uploads://ConnectLive.jpg` → `src/assets/connectlive-banner.jpg.asset.json`

(Uses `lovable-assets create --file ... --filename ...` so the binaries stay out of the repo.)

### 2. Replace the 3D cube block with a looping video
Remove the entire `<div class="scene">…</div>` cube markup, the `CLMark` / `CLWord` / `CLShield` helper components, and the cube `<style>` block. In their place, render:

```tsx
<video
  src={videoAsset.url}
  autoPlay
  loop
  muted
  playsInline
  preload="auto"
  className="mx-auto mt-8 w-full max-w-[360px] rounded-2xl shadow-[0_10px_30px_rgba(31,42,68,0.15)]"
/>
```

Autoplay works because it's `muted` + `playsInline` (required on iOS/Safari).

### 3. Add the JPG footer banner
Directly under the "Quick setup" panel, before the technician sign-in link:

```tsx
<div className="mt-6">
  <img
    src={bannerAsset.url}
    alt="ConnectLive session preview"
    className="w-full rounded-xl"
  />
</div>
```

Sized to the card width so it fits cleanly with rounded corners matching the card radius.

### 4. Untouched
- Card layout, H1, download CTA, `AGENT_DOWNLOAD_URL` constant, ambient gradient background, technician sign-in link, `head()` SEO all stay as-is.
- No changes to `/admin` login, `/console`, or any API/agent code.

## Notes
- No new deps.
- Assets served from Lovable CDN, cached globally.
- Video element has no controls (clean auto-loop hero, like the cube it replaces).
