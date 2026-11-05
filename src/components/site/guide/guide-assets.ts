// Public, immutable brand assets served from Supabase storage (same bucket as
// the session-core model). Models are meshopt-compressed GLBs (the scene wires
// the MeshoptDecoder into GLTFLoader). No credentials or preview-server URLs.
const BASE =
  "https://esjlqcfcwewymmeghbvj.supabase.co/storage/v1/object/public/connectlive-brand-assets/guide";

export const guideAssets = {
  characterUrl: `${BASE}/guide-character.glb`,
  couchUrl: `${BASE}/guide-couch.glb`,
  boardUrl: `${BASE}/guide-board.glb`,
  portraitSeatedUrl: `${BASE}/guide-portrait-seated.webp`,
  portraitStandingUrl: `${BASE}/guide-portrait-standing.webp`,
} as const;
