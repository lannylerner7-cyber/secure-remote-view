# Homepage YouTube Setup Guide Embed

## Goal
Add an "Agent Setup Guide" YouTube embed to the homepage that autoplays (muted) so watch time counts toward the video.

## What we'll do
1. Convert the shared YouTube URL `https://youtu.be/xjtQdMZFOKg?feature=shared` into a privacy-friendly embed URL with autoplay + mute parameters.
2. Add a new bento tile on the homepage (`src/routes/index.tsx`) labeled "Agent Setup Guide" with a responsive 16:9 iframe embed.
3. Ensure the embed uses `autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1` so browsers allow autoplay and views accumulate.
4. Keep the existing homepage styling and motion background intact.

## Technical details
- Embed URL: `https://www.youtube.com/embed/xjtQdMZFOKg?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1`
- Add `loading="lazy"` and `title` attributes for accessibility/performance.
- Place the tile near the existing "Video setup guides are included" section so the narrative flows.
- No backend or route changes required.

## Verification
- Build passes (`tsgo`).
- Preview shows the new tile with the YouTube player loading and autoplaying on page load.
