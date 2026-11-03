// Source-level layout guards only; this is not a Windows/browser runtime test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../imports/connectlive");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const xaml = read("admin/src/Views/LiveSessionWindow.xaml");
assert.match(xaml, /WindowState="Normal"/);
assert.match(xaml, /MaxWidth="960" MaxHeight="540"/);
assert.match(xaml, /HorizontalAlignment="Center" VerticalAlignment="Center"/);
assert.match(xaml, /Stretch="Uniform"/);
assert.match(xaml, /Grid\.Column="1" Width="340"/);
const web = read("src/routes/_authenticated/console.tsx");
assert.match(web, /<RemoteDisplayFrame/);
assert.match(web, /source=\{displaySource\}/);
assert.match(web, /setViewerVideo\(live\.video\)/, "Observe the actual video element, not a stale render-time ref");
assert.match(web, /useVideoSourceSize\(viewerVideo, liveId\)/);
assert.match(web, /viewer-action-rail/);
assert.doesNotMatch(web, /aspect-video/, "Remote source geometry must replace the fixed 16:9 frame");
const frame = read("src/components/console/RemoteDisplayFrame.tsx");
assert.match(frame, /overflow-auto/, "1:1 mode must be pannable");
assert.match(frame, /width: rect\.width, height: rect\.height/);
assert.match(frame, /aria-pressed=\{mode === m\}/);
assert.match(frame, /Awaiting remote screen dimensions/);
assert.match(frame, /width: 1, height: 1, opacity: 0/, "Keep media mounted before metadata arrives");
const metadata = read("src/lib/use-video-source-size.ts");
for (const event of ["loadedmetadata", "resize", "emptied"]) {
  assert.ok(metadata.includes(`addEventListener("${event}", read)`));
  assert.ok(metadata.includes(`removeEventListener("${event}", read)`));
}
assert.match(metadata, /snapshot\.sessionId === sessionId/, "Never return another session's geometry");
assert.match(web, /object-contain/);
assert.match(web, /getContainedPoint/);
assert.match(web, /fullscreenchange/);
assert.match(web, /\[liveId, rtcVideoLive, liveSurfaceDeviceId, viewerVideo\]/,
  "Mount the video when the session row and device arrive");
assert.doesNotMatch(web, /: videoDecoding \|\| liveFrame\?\.frame \? \(/,
  "Video host must exist before either transport delivers its first frame");
assert.match(web, /videoDecoding \|\| viewerPaused \? "" : "opacity-0"/,
  "Keep the video in layout while waiting for its first presented frame");
assert.match(read("src/lib/webrtc-live.ts"), /createDataChannel\("input"/,
  "Preserve GitHub's agent-compatible input channel name");
const cfg = JSON.parse(read("admin/src/admin.config.json"));
assert.equal(new URL(cfg.supabaseUrl).origin, cfg.supabaseUrl);
assert.equal(new URL(cfg.supabaseUrl).protocol, "https:");
assert.equal(cfg.supabaseAnonKey, "", "Do not commit deployment keys");
console.log("PASS: bounded admin viewer source layout and credential-free configuration");
