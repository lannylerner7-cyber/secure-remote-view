// Wording and wiring of the live viewer's "?" popup. Pure function and source
// checks only: no browser, device, database, credential or network access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");

const root = "src";
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(`${root}/lib/media-help.ts`, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exports_ });
const { describeMediaHelp, AGENT_LOG_PATH } = exports_;

const base = { videoDecoding: false, jpegFresh: false, viewerPaused: false, rtcState: "connecting", recovery: null };
const recovery = (phase, extra = {}) => ({
  phase, profile: { label: "H.264 preferred" }, attempt: 2, codec: null, path: null, ...extra,
});
const row = (help, label) => help.rows.find(r => r.label === label)?.value;

test("live video is reported as healthy with JPEG on standby", () => {
  const help = describeMediaHelp({ ...base, videoDecoding: true, jpegFresh: true, rtcState: "connected",
    recovery: recovery("live", { codec: "H264", path: "host" }) });
  assert.equal(help.attention, false);
  assert.match(help.now, /Live video is playing\. JPEG is on standby/);
  assert.equal(row(help, "Video connection"), "Connected");
  assert.equal(row(help, "Codec"), "H264");
  assert.equal(row(help, "Route"), "Direct connection");
  assert.equal(row(help, "Retries"), undefined);
});

test("a relayed or unreported route is named, never guessed", () => {
  const live = { ...base, videoDecoding: true, rtcState: "connected" };
  assert.equal(row(describeMediaHelp({ ...live, recovery: recovery("live", { codec: "VP8", path: "relay" }) }), "Route"), "TURN relay");
  const unknown = describeMediaHelp({ ...live, recovery: recovery("live") });
  assert.equal(row(unknown, "Route"), "Not yet reported");
  assert.equal(row(unknown, "Codec"), "Not yet reported");
});

test("JPEG on screen needs attention and says video is recovering", () => {
  const help = describeMediaHelp({ ...base, jpegFresh: true, recovery: recovery("waiting") });
  assert.equal(help.attention, true);
  assert.match(help.now, /Showing JPEG pictures while video recovers automatically/);
  assert.equal(row(help, "Retries"), "Next automatic retry: H.264 preferred · attempt 3");
});

test("an attempt in flight reports its own number", () => {
  const help = describeMediaHelp({ ...base, recovery: recovery("connecting") });
  assert.equal(row(help, "Retries"), "Trying: H.264 preferred · attempt 2");
});

test("no picture yet needs attention and keeps the permission reminder", () => {
  const help = describeMediaHelp(base);
  assert.equal(help.attention, true);
  assert.match(help.now, /Waiting for an authorized video stream or a fresh JPEG picture/);
  assert.match(help.now, /Viewing permission is still required/);
  assert.equal(help.rows.map(r => r.label).join("|"), "Video connection");
});

test("stopped retries need attention even while a last frame is decoding", () => {
  const help = describeMediaHelp({ ...base, videoDecoding: true, recovery: recovery("stopped") });
  assert.equal(help.attention, true);
  assert.match(row(help, "Retries"), /Stopped because viewing permission or viewer ownership changed/);
});

test("recording finalization is explained instead of a retry count", () => {
  const help = describeMediaHelp({ ...base, recovery: recovery("finishing-recording") });
  assert.equal(row(help, "Retries"), "Saving the recording segment before reconnecting.");
});

test("a deliberate local pause is explained and is not flagged as degraded", () => {
  const help = describeMediaHelp({ ...base, viewerPaused: true });
  assert.equal(help.attention, false);
  assert.match(help.now, /This viewer is paused on your computer/);
});

test("connection states use plain words and unknown states pass through", () => {
  for (const [state, label] of [["idle", "Not started"], ["failed", "Failed"],
    ["superseded", "Taken over by another viewer"], ["future-state", "future-state"]])
    assert.equal(row(describeMediaHelp({ ...base, rtcState: state }), "Video connection"), label);
});

test("the popup is a keyboard-reachable control that renders inside the viewer", () => {
  const help = fs.readFileSync(`${root}/components/console/MediaHelpButton.tsx`, "utf8");
  const strip = fs.readFileSync(`${root}/components/console/SessionStatusStrip.tsx`, "utf8");
  const viewer = fs.readFileSync(`${root}/routes/_authenticated/console.tsx`, "utf8");
  assert.equal(AGENT_LOG_PATH, "%LOCALAPPDATA%\\ConnectLive\\logs");
  assert.match(help, /<button\s+type="button"\s+data-testid="button-media-help"/);
  assert.match(help, /aria-label=\{help\.attention/);
  assert.match(help, /<PopoverPrimitive\.Portal container=\{container \?\? undefined\}>/,
    "A body-level portal is hidden while the viewer panel is fullscreen");
  assert.match(help, /if \(next\) setContainer\(getContainer\(\)\)/);
  assert.match(help, /\{AGENT_LOG_PATH\}/);
  assert.match(viewer, /getContainer=\{\(\) => viewerPanelRef\.current\}/);
  assert.match(viewer, /jpegFresh=\{active && !!liveFrame\?\.frame && frameAge < 8000\}/);
  assert.match(strip, /\{help\}/);
  assert.match(viewer, /data-testid="video-only-session-notice"/, "The video-only notice is unchanged");
});
