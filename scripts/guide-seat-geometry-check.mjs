// Run with a directory containing the three current public models named
// character.glb, couch.glb and board.glb. No downloads, GPU, credentials or
// database writes. This checks geometry; it does not certify rendered visuals.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const THREE = await import(pathToFileURL(require.resolve("three").replace(/three\.cjs$/, "three.module.js")).href);
const { GLTFLoader } = await import(pathToFileURL(require.resolve("three/examples/jsm/loaders/GLTFLoader.js")).href);
const { MeshoptDecoder } = await import(pathToFileURL(require.resolve("three/examples/jsm/libs/meshopt_decoder.module.js")).href);
const assetDir = process.argv[2];
if (!assetDir) throw new Error("Usage: node scripts/guide-seat-geometry-check.mjs <model-directory>");

async function loadGeometry(name) {
  const original = fs.readFileSync(path.join(assetDir, `${name}.glb`));
  assert.equal(original.readUInt32LE(0), 0x46546c67, "Expected GLB");
  const length = original.readUInt32LE(12);
  const json = JSON.parse(original.subarray(20, 20 + length));
  // Keep the exact meshes, skinning, bones and clips; Node needs no textures.
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives) delete primitive.material;
  delete json.materials; delete json.textures; delete json.images; delete json.samplers;
  const data = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4, 32);
  data.copy(padded);
  const bin = original.subarray(20 + length);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const buffer = Buffer.concat([header, padded, bin]);
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length), "");
}

const [character, couch, board] = await Promise.all(["character", "couch", "board"].map(loadGeometry));
const source = fs.readFileSync(path.join(root, "src/components/site/guide/guide-stage-engine.ts"), "utf8");
// Test-only inspection of the actual production stage closure. No debug
// handle, mutation API or model data is exposed to visitors by the app.
const marker = "    setActivity(a, nonce) {";
assert.equal(source.split(marker).length, 2, "Update the test adapter if the stage API changes");
const instrumented = source.replace(marker, `    inspect: () => ({
      seated: loc === "seat" && !seg,
      yawDelta: wrapAngle(yaw - seatYaw),
      facingDelta: wrapAngle(couchPivot.rotation.y - seatFacing),
      cushion: { top: cu.top, front: cu.front, back: cu.back },
      hip: couchPivot.worldToLocal(hips.getWorldPosition(V())).toArray(),
      knees: legs.map(leg => couchPivot.worldToLocal(leg.shin.getWorldPosition(V())).toArray()),
      ankles: legs.map(leg => couchPivot.worldToLocal(leg.foot.getWorldPosition(V())).toArray()),
      floor: vertexMin(),
      boardGap: couchBox.min.x - boardBox.max.x
    }),
${marker}`);
const exports = {};
vm.runInNewContext(ts.transpileModule(instrumented, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports,
  require: (name) => {
    if (name === "./guide-board-texture") return { paintBoard() {} };
    throw new Error(`Unexpected test dependency ${name}`);
  },
  document: { createElement: () => ({ getContext: () => null }) },
});
const phases = new Set();
const stage = exports.buildStage({
  THREE,
  renderer: { setViewport() {}, render() {}, setSize() {} },
  scene: new THREE.Scene(),
  character: character.scene, clips: character.animations,
  couch: couch.scene, board: board.scene,
  font: "sans-serif", reducedMotion: false, onPhase: (phase) => phases.add(phase),
});
const pointer = { x: 0, y: 0 };
const observations = [];
function verifySeat(label) {
  const state = stage.inspect();
  assert.ok(state.seated, `${label}: host must be settled in seat`);
  assert.ok(Math.abs(state.yawDelta) < 0.001, `${label}: host facing must match seat`);
  assert.ok(Math.abs(state.facingDelta) < 0.001, `${label}: chair rotation must match seat`);
  assert.ok(state.hip[2] > state.cushion.back + 0.06 && state.hip[2] < state.cushion.front - 0.09,
    `${label}: hips must remain supported by cushion`);
  for (const [side, knee] of state.knees.entries()) {
    assert.ok(knee[2] > state.cushion.front + 0.05, `${label}: knee ${side} intersects cushion lip`);
    assert.ok(state.ankles[side][2] > state.cushion.front + 0.05, `${label}: shin ${side} passes through seat`);
  }
  assert.ok(Math.abs(state.floor) < 0.025, `${label}: feet must stay close to floor (${state.floor})`);
  assert.ok(state.boardGap >= 0.99, `${label}: chair must not crowd the board`);
  observations.push({
    label,
    kneeClearanceCm: state.knees.map((knee) => +((knee[2] - state.cushion.front) * 100).toFixed(2)),
    floorOffsetCm: +(state.floor * 100).toFixed(2),
  });
}
function advance(seconds) {
  for (let frame = 0; frame < seconds * 30; frame++) stage.tick(1 / 30, pointer);
}
try {
  stage.resize(1300, 550, false);
  stage.tick(0, pointer);
  verifySeat("initial");
  for (let sample = 1; sample <= 6; sample++) {
    advance(2);
    verifySeat(`idle ${sample * 2}s`);
  }
  stage.setActivity("greeting", 1);
  advance(4);
  verifySeat("seated greeting");
  stage.setActivity("speaking", 2);
  advance(12);
  stage.setActivity("presenting", 2);
  advance(12);
  stage.setActivity("seated", 2);
  advance(16);
  verifySeat("returned from board");
  stage.resize(390, 600, true);
  advance(1);
  verifySeat("phone layout");
  for (const phase of ["rising", "walking", "speaking", "presenting", "sitting", "seated"]) {
    assert.ok(phases.has(phase), `Missing transition ${phase}`);
  }
  console.info(JSON.stringify({ passed: true, observations, phases: [...phases] }, null, 2));
} finally {
  stage.dispose();
}
