// Focused static checks for the session-tools layout and input-pause wiring.
const fs = require("fs");
const assert = require("assert");
const root = "src";
const console_ = fs.readFileSync(`${root}/routes/_authenticated/console.tsx`, "utf8");
const tools = fs.readFileSync(`${root}/components/console/session-tools.ts`, "utf8");

const order = ["Screen", "Control", "Files", "Clipboard", "Recording", "Connection health", "Windows sign-in", "Session details"];
let last = -1;
for (const label of order) {
  const i = tools.indexOf(`label: "${label}"`);
  assert(i > last, `tool order: ${label}`);
  last = i;
}
assert(console_.includes("live.onInputPause("), "subscribes to input pause");
assert(console_.includes("offInputPause();"), "unsubscribes on peer teardown");
assert(/capturedEpoch !== live\.inputPause\(\)\.epoch/.test(console_), "rejects stale epoch");
assert(console_.includes("input_epoch: capturedEpoch"), "sends captured epoch");
assert(console_.includes("inputGateOpen &&"), "control readiness includes input gate");
assert(console_.includes('data-testid="button-end-session"') && console_.includes('data-testid="button-close-viewer"'), "end/close distinct");
assert(console_.includes("hidden={railCollapsed}"), "tools hidden, not unmounted");
assert(!console_.includes("setCurtain(") || !/setRemoteInputPaused[\s\S]{0,1200}setCurtain\(/.test(console_), "pause never toggles curtain");
assert(console_.includes("!userPausedControl"), "paused control blocks Windows sign-in");
console.log("session-tools-ui: ok");
