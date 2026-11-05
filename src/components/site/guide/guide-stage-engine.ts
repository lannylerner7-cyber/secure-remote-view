import type * as T from "three";
import type { GuideActivity, GuideBoardPage } from "./guide-contract";
import { paintBoard } from "./guide-board-texture";

export type Three = typeof import("three");

type ClipKey = "sit" | "walk" | "wave" | "talkA" | "talkB";
type Loc = "seat" | "stand" | "front" | "board";
type Spot = { x: number; z: number; yaw: number };
type Seg = {
  kind: "rise" | "sit" | "walk";
  t: number;
  dur: number;
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  fyaw: number;
  tyaw: number;
  travelYaw: number;
  to: Loc;
  ts: number;
};

const CLIP_NAMES: Record<ClipKey, string> = {
  sit: "Sit_Cross_Legged",
  walk: "Walking",
  wave: "Wave_One_Hand",
  talkA: "Talk_with_Hands_Open",
  talkB: "Talk_with_Left_Hand_Raised",
};
const KEYS = Object.keys(CLIP_NAMES) as ClipKey[];
const LOWER_RAW = ["spine", "thigh.L", "thigh.R", "shin.L", "shin.R", "foot.L", "foot.R", "toe.L", "toe.R"];

const smooth = (p: number) => {
  const c = Math.min(1, Math.max(0, p));
  return c * c * (3 - 2 * c);
};
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const approachAngle = (a: number, b: number, k: number) => a + wrapAngle(b - a) * Math.min(1, k);

export type StageApi = {
  setActivity: (a: GuideActivity, nonce: number) => void;
  setBoard: (page: GuideBoardPage | null) => void;
  resize: (w: number, h: number, stacked: boolean) => void;
  tick: (dt: number, pointer: { x: number; y: number }) => void;
  dispose: () => void;
};

export function buildStage(opts: {
  THREE: Three;
  renderer: T.WebGLRenderer;
  scene: T.Scene;
  character: T.Object3D;
  clips: T.AnimationClip[];
  couch: T.Object3D;
  board: T.Object3D;
  font: string;
  reducedMotion: boolean;
  onPhase: (phase: string) => void;
}): StageApi {
  const { THREE, renderer, scene, character, couch, board } = opts;
  const disposers: (() => void)[] = [];
  const V = () => new THREE.Vector3();
  const sanitize = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n);
  const LOWER = new Set(LOWER_RAW.map(sanitize));
  const HIPS = sanitize("spine");
  const motion = opts.reducedMotion ? 0.65 : 1;

  const measure = (root: T.Object3D) => {
    root.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(root, true);
  };

  const lounge = new THREE.Group();
  scene.add(lounge);
  const ray = new THREE.Raycaster();

  // ------------------------------------------------------------- character
  const bind = measure(character);
  character.scale.setScalar(1.68 / (bind.getSize(V()).y || 1));
  lounge.add(character);
  const bone = (n: string) => {
    const b = character.getObjectByName(sanitize(n));
    if (!b) throw new Error(`missing bone ${n}`);
    return b;
  };
  const hips = bone("spine");
  const legs = (["L", "R"] as const).map((s) => ({
    thigh: bone(`thigh.${s}`),
    shin: bone(`shin.${s}`),
    foot: bone(`foot.${s}`),
    toe: bone(`toe.${s}`),
    side: 1,
  }));
  const skinned: T.SkinnedMesh[] = [];
  character.traverse((o) => {
    const m = o as T.SkinnedMesh;
    if (m.isSkinnedMesh) {
      skinned.push(m);
      m.frustumCulled = false;
    }
  });

  // Character-local facing and hip sides, read from the rig in bind pose.
  character.updateMatrixWorld(true);
  const invQ = character.getWorldQuaternion(new THREE.Quaternion()).invert();
  const toLocal = (a: T.Vector3) => a.applyQuaternion(invQ);
  const fwd = Math.sign(toLocal(legs[0].toe.getWorldPosition(V()).sub(legs[0].foot.getWorldPosition(V()))).z) || 1;
  for (const leg of legs) {
    leg.side = Math.sign(toLocal(leg.thigh.getWorldPosition(V()).sub(hips.getWorldPosition(V()))).x) || 1;
  }
  const yawFor = (dx: number, dz: number) => Math.atan2(dx, dz) + (fwd < 0 ? Math.PI : 0);

  // ------------------------------------------------------------- animation
  const mixer = new THREE.AnimationMixer(character);
  const split = (clip: T.AnimationClip, lower: boolean) =>
    new THREE.AnimationClip(
      `${clip.name}-${lower ? "L" : "U"}`,
      clip.duration,
      clip.tracks
        .filter((tr) => {
          const p = THREE.PropertyBinding.parseTrackName(tr.name);
          // Root motion is owned by the stage: hips translation is stripped.
          if (p.nodeName === HIPS && p.propertyName === "position") return false;
          return LOWER.has(p.nodeName) === lower;
        })
        .map((tr) => tr.clone()),
    );
  const U = {} as Record<ClipKey, T.AnimationAction>;
  const L = {} as Record<ClipKey, T.AnimationAction>;
  for (const k of KEYS) {
    const clip = opts.clips.find((c) => c.name === CLIP_NAMES[k]);
    if (!clip) throw new Error(`missing clip ${CLIP_NAMES[k]}`);
    U[k] = mixer.clipAction(split(clip, false));
    L[k] = mixer.clipAction(split(clip, true));
    for (const a of [U[k], L[k]]) {
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.play();
      a.setEffectiveWeight(0);
    }
  }
  const chan = {
    U: { target: "sit" as ClipKey, w: Object.fromEntries(KEYS.map((k) => [k, k === "sit" ? 1 : 0])) as Record<ClipKey, number>, acts: U, rate: 5 },
    L: { target: "sit" as ClipKey, w: Object.fromEntries(KEYS.map((k) => [k, k === "sit" ? 1 : 0])) as Record<ClipKey, number>, acts: L, rate: 4.5 },
  };
  const applyWeights = (dt: number) => {
    for (const c of [chan.U, chan.L]) {
      const f = dt < 0 ? 1 : 1 - Math.exp(-c.rate * dt);
      let total = 0;
      for (const k of KEYS) {
        c.w[k] += ((k === c.target ? 1 : 0) - c.w[k]) * f;
        total += c.w[k];
      }
      for (const k of KEYS) c.acts[k].setEffectiveWeight(total > 0 ? c.w[k] / total : 0);
    }
  };

  // Procedural sitting legs: thighs forward along the cushion, shins down to
  // the floor, feet flat. Blended by "s" (seatedness) on top of the clip.
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const qc = new THREE.Quaternion();
  const ident = new THREE.Quaternion();
  const pa = V();
  const pb = V();
  const dir = V();
  const aim = (b: T.Object3D, child: T.Object3D, target: T.Vector3, s: number) => {
    b.getWorldPosition(pa);
    child.getWorldPosition(pb);
    dir.subVectors(pb, pa).normalize();
    qc.setFromUnitVectors(dir, target);
    qa.slerpQuaternions(ident, qc, s);
    b.getWorldQuaternion(qb);
    qb.premultiply(qa);
    b.parent!.getWorldQuaternion(qa);
    b.quaternion.copy(qa.invert().multiply(qb));
    b.updateMatrixWorld(true);
  };
  const dThigh = V();
  const dShin = V();
  const dFoot = V();
  const charQ = new THREE.Quaternion();
  const applyLegs = (s: number) => {
    if (s <= 0.001) return;
    character.updateMatrixWorld(true);
    character.getWorldQuaternion(charQ);
    for (const leg of legs) {
      dThigh.set(leg.side * 0.11, -0.07, fwd).normalize().applyQuaternion(charQ);
      dShin.set(leg.side * 0.03, -1, fwd * 0.16).normalize().applyQuaternion(charQ);
      dFoot.set(0, -0.3, fwd).normalize().applyQuaternion(charQ);
      aim(leg.thigh, leg.shin, dThigh, s);
      aim(leg.shin, leg.foot, dShin, s);
      aim(leg.foot, leg.toe, dFoot, s);
    }
  };

  const vtx = V();
  const vertexMin = (filter?: (p: T.Vector3) => boolean) => {
    character.updateMatrixWorld(true);
    let min = Infinity;
    for (const m of skinned) {
      const count = m.geometry.attributes.position.count;
      const step = Math.max(1, Math.floor(count / 8000));
      for (let i = 0; i < count; i += step) {
        m.getVertexPosition(i, vtx);
        vtx.applyMatrix4(m.matrixWorld);
        if (filter && !filter(vtx)) continue;
        if (vtx.y < min) min = vtx.y;
      }
    }
    return min;
  };
  const poseOnly = (u: ClipKey, l: ClipKey, t: number, s: number) => {
    for (const k of KEYS) {
      U[k].setEffectiveWeight(k === u ? 1 : 0);
      L[k].setEffectiveWeight(k === l ? 1 : 0);
      U[k].time = t;
      L[k].time = t;
    }
    mixer.update(0);
    applyLegs(s);
    character.updateMatrixWorld(true);
  };

  // Floor contacts per standing pose (not reused bounds).
  const faceCam = yawFor(0, 1);
  character.position.set(0, 0, 0);
  character.rotation.set(0, faceCam, 0);
  poseOnly("talkA", "talkA", 0, 0);
  const talkFloor = -vertexMin();
  const kneeH = legs[0].shin.getWorldPosition(V()).y + talkFloor;
  const walkDur = L.walk.getClip().duration;
  let walkFloor = 0;
  let fMin = Infinity;
  let fMax = -Infinity;
  const SAMPLES = 16;
  for (let i = 0; i < SAMPLES; i++) {
    poseOnly("walk", "walk", (i / SAMPLES) * walkDur, 0);
    walkFloor += -vertexMin() / SAMPLES;
    const fz = toLocal(legs[0].foot.getWorldPosition(V())).z * fwd;
    fMin = Math.min(fMin, fz);
    fMax = Math.max(fMax, fz);
  }
  const stepLen = Math.min(0.85, Math.max(0.35, fMax - fMin));
  const walkSpeed = (2 * stepLen) / walkDur;

  // ------------------------------------------------------------- couch
  const couchSize = measure(couch).getSize(V());
  couch.scale.multiplyScalar(2.05 / (couchSize.x || 1));
  lounge.add(couch);
  const placeAt = (o: T.Object3D, x: number, z: number) => {
    const b = measure(o);
    const c = b.getCenter(V());
    o.position.x += x - c.x;
    o.position.z += z - c.z;
    o.position.y -= b.min.y;
    o.updateMatrixWorld(true);
  };
  const scanCouch = () => {
    const b = measure(couch);
    const cx = (b.min.x + b.max.x) / 2;
    const hits: { z: number; y: number }[] = [];
    const N = 56;
    for (let i = 0; i < N; i++) {
      const z = b.max.z - ((i + 0.5) / N) * (b.max.z - b.min.z);
      ray.set(new THREE.Vector3(cx, b.max.y + 1, z), new THREE.Vector3(0, -1, 0));
      const h = ray.intersectObject(couch, true)[0];
      if (h) hits.push({ z, y: h.point.y });
    }
    return { b, hits };
  };
  placeAt(couch, 0, 0);
  {
    const { b, hits } = scanCouch();
    const mid = (b.min.z + b.max.z) / 2;
    const avg = (f: (h: { z: number }) => boolean) => {
      const s = hits.filter(f);
      return s.reduce((a, h) => a + (h as { y: number }).y, 0) / (s.length || 1);
    };
    // Backrest must be away from camera (-z).
    if (avg((h) => h.z > mid) > avg((h) => h.z < mid)) {
      couch.rotation.y += Math.PI;
      placeAt(couch, 0, 0);
    }
  }
  const cushion = () => {
    const { b, hits } = scanCouch();
    const band = hits.slice(Math.floor(hits.length * 0.18), Math.ceil(hits.length * 0.5)).map((h) => h.y).sort((x, y) => x - y);
    const top = band.length ? band[Math.floor(band.length / 2)] : b.min.y + (b.max.y - b.min.y) * 0.5;
    let front = b.max.z;
    let back = b.min.z + (b.max.z - b.min.z) * 0.3;
    let started = false;
    for (const h of hits) {
      if (!started && Math.abs(h.y - top) < 0.05) {
        started = true;
        front = h.z;
      } else if (started) {
        if (h.y > top + 0.07) break;
        back = h.z;
      }
    }
    return { b, top, front, back };
  };
  let cu = cushion();
  const f = Math.min(1.35, Math.max(0.8, (kneeH - 0.03) / (cu.top || 1)));
  couch.scale.multiplyScalar(f);
  const COUCH_X = 0.55;
  placeAt(couch, COUCH_X, -0.15);
  cu = cushion();
  const couchBox = cu.b;

  // ------------------------------------------------------------- board
  const boardPivot = new THREE.Group();
  lounge.add(boardPivot);
  const bSize = measure(board).getSize(V());
  board.scale.multiplyScalar(1.95 / (bSize.y || 1));
  boardPivot.add(board);
  placeAt(board, 0, 0);
  const bb = measure(board);
  const hitsZ: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 28; i++) {
    for (let j = 0; j < 36; j++) {
      const x = bb.min.x + ((i + 0.5) / 28) * (bb.max.x - bb.min.x);
      const y = bb.min.y + ((j + 0.5) / 36) * (bb.max.y - bb.min.y);
      ray.set(new THREE.Vector3(x, y, bb.max.z + 2), new THREE.Vector3(0, 0, -1));
      const h = ray.intersectObject(board, true)[0];
      if (h) hitsZ.push({ x, y, z: h.point.z });
    }
  }
  const buckets = new Map<number, number>();
  for (const h of hitsZ) {
    const k = Math.round(h.z / 0.01);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  let modeK = 0;
  let modeN = 0;
  for (const [k, n] of buckets) if (n > modeN) [modeK, modeN] = [k, n];
  const face = hitsZ.filter((h) => Math.abs(h.z - modeK * 0.01) < 0.015);
  const bw = bb.max.x - bb.min.x;
  const bh = bb.max.y - bb.min.y;
  let rect = { x0: bb.min.x + bw * 0.1, x1: bb.max.x - bw * 0.1, y0: bb.min.y + bh * 0.3, y1: bb.max.y - bh * 0.05, z: bb.max.z };
  if (face.length > 40) {
    const xs = face.map((h) => h.x);
    const ys = face.map((h) => h.y);
    rect = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z: modeK * 0.01 };
  }
  const inset = 0.035;
  const pw = (rect.x1 - rect.x0) * (1 - inset * 2);
  const ph = (rect.y1 - rect.y0) * (1 - inset * 2);
  const texCanvas = document.createElement("canvas");
  texCanvas.width = 1024;
  texCanvas.height = Math.min(2048, Math.max(512, Math.round((1024 * ph) / (pw || 1))));
  const boardTex = new THREE.CanvasTexture(texCanvas);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  boardTex.generateMipmaps = false;
  boardTex.minFilter = THREE.LinearFilter;
  boardTex.magFilter = THREE.LinearFilter;
  const panelGeo = new THREE.PlaneGeometry(pw, ph);
  const panelMat = new THREE.MeshBasicMaterial({ map: boardTex, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const panel = new THREE.Mesh(panelGeo, panelMat);
  panel.position.set((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, rect.z + 0.006);
  boardPivot.add(panel);
  disposers.push(() => {
    boardTex.dispose();
    panelGeo.dispose();
    panelMat.dispose();
  });
  boardPivot.rotation.y = 0.3;
  const BOARD_GAP = 1.0;
  {
    const pb2 = measure(boardPivot);
    boardPivot.position.x += couchBox.min.x - BOARD_GAP - pb2.max.x;
    boardPivot.position.z += -0.2 - pb2.getCenter(V()).z;
  }
  const boardBox = measure(boardPivot);
  let boardPage: GuideBoardPage | null = null;
  const repaint = () => {
    paintBoard(texCanvas, boardPage, opts.font);
    boardTex.needsUpdate = true;
  };
  repaint();

  // ------------------------------------------------------------- spots
  const seatYaw = yawFor(-0.45, 1);
  character.rotation.set(0, seatYaw, 0);
  poseOnly("sit", "sit", 0, 1);
  const hipW = hips.getWorldPosition(V());
  const rad = 0.14;
  const contact = vertexMin((p) => (p.x - hipW.x) ** 2 + (p.z - hipW.z) ** 2 < rad * rad);
  const sink = 0.035;
  const seatY = cu.top - (Number.isFinite(contact) ? contact : hipW.y - 0.1) - sink;
  const hipTargetZ = cu.back + Math.min(0.24, (cu.front - cu.back) * 0.42);
  const seatSpot: Spot = { x: COUCH_X - hipW.x, z: hipTargetZ - hipW.z, yaw: seatYaw };
  const camGuess = new THREE.Vector3(0, 1, 9);
  const spots: Record<Exclude<Loc, "seat">, Spot> = {
    stand: { x: COUCH_X, z: couchBox.max.z + 0.28, yaw: faceCam },
    front: { x: COUCH_X - 0.1, z: couchBox.max.z + 0.85, yaw: yawFor(camGuess.x - (COUCH_X - 0.1), camGuess.z) },
    board: { x: boardBox.max.x + 0.42, z: couchBox.max.z + 0.12, yaw: yawFor(-0.42, 1) },
  };

  // ------------------------------------------------------------- dressing
  const blobCanvas = document.createElement("canvas");
  blobCanvas.width = blobCanvas.height = 256;
  const bctx = blobCanvas.getContext("2d");
  if (bctx) {
    const g = bctx.createRadialGradient(128, 128, 6, 128, 128, 128);
    g.addColorStop(0, "rgba(0,0,0,0.6)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, 256, 256);
  }
  const blobTex = new THREE.CanvasTexture(blobCanvas);
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
  const blobGeo = new THREE.CircleGeometry(1, 48);
  const blob = (x: number, z: number, sx: number, sz: number) => {
    const m = new THREE.Mesh(blobGeo, blobMat);
    m.rotation.x = -Math.PI / 2;
    m.scale.set(sx, sz, 1);
    m.position.set(x, 0.004, z);
    lounge.add(m);
    return m;
  };
  // Rug: a soft tinted floor disc that ties couch, board and host into one room.
  const rugCanvas = document.createElement("canvas");
  rugCanvas.width = rugCanvas.height = 256;
  const rctx = rugCanvas.getContext("2d");
  if (rctx) {
    const g = rctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, "rgba(110,168,255,0.16)");
    g.addColorStop(0.7, "rgba(110,168,255,0.05)");
    g.addColorStop(1, "rgba(110,168,255,0)");
    rctx.fillStyle = g;
    rctx.fillRect(0, 0, 256, 256);
  }
  const rugTex = new THREE.CanvasTexture(rugCanvas);
  const rugMat = new THREE.MeshBasicMaterial({ map: rugTex, transparent: true, depthWrite: false });
  const rug = new THREE.Mesh(blobGeo, rugMat);
  rug.rotation.x = -Math.PI / 2;
  const roomCx = (boardBox.min.x + couchBox.max.x) / 2;
  rug.scale.set((couchBox.max.x - boardBox.min.x) * 0.72, 1.9, 1);
  rug.position.set(roomCx, 0.002, couchBox.max.z * 0.4);
  lounge.add(rug);
  blob((couchBox.min.x + couchBox.max.x) / 2, (couchBox.min.z + couchBox.max.z) / 2, (couchBox.max.x - couchBox.min.x) * 0.62, 0.75);
  const boardBlob = blob((boardBox.min.x + boardBox.max.x) / 2, (boardBox.min.z + boardBox.max.z) / 2, 0.75, 0.45);
  const hostBlob = blob(0, 0, 0.36, 0.3);
  disposers.push(() => {
    blobTex.dispose();
    blobMat.dispose();
    blobGeo.dispose();
    rugTex.dispose();
    rugMat.dispose();
  });

  // ------------------------------------------------------------- camera
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
  // Desktop frames couch + board + every host spot. Stacked (phone) layout
  // drops the physical board (the DOM board above is the readable copy) and
  // frames couch + every host destination, including the presenting spot.
  const frameFor = (withBoard: boolean) => {
    const box = new THREE.Box3().union(couchBox);
    if (withBoard) box.union(boardBox);
    for (const s of Object.values(spots)) {
      box.expandByPoint(new THREE.Vector3(s.x - 0.3, 1.76, s.z + 0.12));
      box.expandByPoint(new THREE.Vector3(s.x + 0.3, 0, s.z - 0.12));
    }
    const c = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (i) =>
        new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z),
    );
    const l = box.getCenter(V());
    l.y = box.max.y * 0.46;
    return { corners: c, look: l };
  };
  const stageFrame = frameFor(true);
  const stackedFrame = frameFor(false);
  let corners = stageFrame.corners;
  const look = stageFrame.look.clone();
  const camDir = new THREE.Vector3(0.1, 0.27, 1).normalize();
  const basePos = V();
  const proj = V();
  let viewH = 1;
  let viewW = 1;
  let stacked = false;
  const fits = (margin: number) => {
    camera.updateMatrixWorld(true);
    for (const c of corners) {
      proj.copy(c).project(camera);
      if (Math.abs(proj.x) > margin || Math.abs(proj.y) > margin * 0.98) return false;
    }
    return true;
  };
  const fit = () => {
    let lo = 1;
    let hi = 40;
    for (let i = 0; i < 26; i++) {
      const d = (lo + hi) / 2;
      camera.position.copy(look).addScaledVector(camDir, d);
      camera.lookAt(look);
      if (fits(0.94)) hi = d;
      else lo = d;
    }
    camera.position.copy(look).addScaledVector(camDir, hi);
    camera.lookAt(look);
    basePos.copy(camera.position);
    // Tighten: zoom/offset so the projected scene bounds fill the frame.
    camera.clearViewOffset();
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of corners) {
      proj.copy(c).project(camera);
      x0 = Math.min(x0, proj.x); x1 = Math.max(x1, proj.x);
      y0 = Math.min(y0, proj.y); y1 = Math.max(y1, proj.y);
    }
    // Margin leaves room for the small pointer parallax.
    const zoom = Math.min(0.95 / ((x1 - x0) / 2 || 1), 0.93 / ((y1 - y0) / 2 || 1));
    camera.zoom = zoom;
    const fw = 1000;
    const fh = Math.round(1000 / camera.aspect);
    camera.setViewOffset(fw, fh, (((x0 + x1) / 2) * zoom * fw) / 2, (-((y0 + y1) / 2) * zoom * fh) / 2, fw, fh);
    camera.updateProjectionMatrix();
  };
  spots.front.yaw = yawFor(0.25, 1);

  // ------------------------------------------------------------- state
  let loc: Loc = "seat";
  let s = 1;
  const pos = { x: seatSpot.x, z: seatSpot.z };
  let yaw = seatYaw;
  let seg: Seg | null = null;
  let target: GuideActivity = "seated";
  let lastNonce = -1;
  let wavePending = false;
  let waveT = -1;
  let talkT = 0;
  let paused = false;
  let phase = "";
  const emit = (p: string) => {
    if (p !== phase) {
      phase = p;
      opts.onPhase(p);
    }
  };

  const spotOf = (l: Loc): Spot => (l === "seat" ? seatSpot : spots[l]);
  const startWalk = (to: Loc) => {
    const sp = spotOf(to);
    const dx = sp.x - pos.x;
    const dz = sp.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) {
      loc = to;
      return;
    }
    const n = Math.max(2, Math.round(dist / stepLen));
    const ts = Math.min(1.3, Math.max(0.7, dist / (n * stepLen)));
    seg = { kind: "walk", t: 0, dur: dist / (walkSpeed * ts), fx: pos.x, fz: pos.z, tx: sp.x, tz: sp.z, fyaw: yaw, tyaw: sp.yaw, travelYaw: yawFor(dx, dz), to, ts };
    U.walk.time = 0;
    L.walk.time = 0;
  };
  const plan = () => {
    const desired: Loc | null =
      target === "seated" || target === "greeting" ? "seat" : target === "speaking" ? "front" : target === "presenting" ? "board" : null;
    if (desired === null || desired === loc) return false;
    if (loc === "seat") {
      // A seated greeting must not resume after an entire spoken explanation.
      waveT = -1;
      wavePending = false;
      seg = { kind: "rise", t: 0, dur: 1.25 * motion, fx: pos.x, fz: pos.z, tx: spots.stand.x, tz: spots.stand.z, fyaw: yaw, tyaw: spots.stand.yaw, travelYaw: yaw, to: "stand", ts: 1 };
    } else if (desired === "seat") {
      if (loc !== "stand") startWalk("stand");
      else seg = { kind: "sit", t: 0, dur: 1.35 * motion, fx: pos.x, fz: pos.z, tx: seatSpot.x, tz: seatSpot.z, fyaw: yaw, tyaw: seatYaw, travelYaw: yaw, to: "seat", ts: 1 };
    } else startWalk(desired);
    return true;
  };

  const runSeg = (dt: number) => {
    const g = seg!;
    g.t += dt;
    const p = Math.min(1, g.t / g.dur);
    if (g.kind === "walk") {
      chan.U.target = "walk";
      chan.L.target = g.dur - g.t < 0.28 ? "talkA" : "walk";
      U.walk.timeScale = L.walk.timeScale = g.ts;
      pos.x = g.fx + (g.tx - g.fx) * p;
      pos.z = g.fz + (g.tz - g.fz) * p;
      const remaining = Math.hypot(g.tx - pos.x, g.tz - pos.z);
      yaw = approachAngle(yaw, remaining < 0.4 ? g.tyaw : g.travelYaw, dt * 7);
      emit("walking");
    } else {
      const e = smooth(p);
      const up = g.kind === "rise";
      s = up ? 1 - e : e;
      // Hips travel forward a touch earlier than they rise (weight over feet).
      const m = up ? smooth(Math.min(1, p * 1.25)) : smooth(Math.max(0, p * 1.25 - 0.25));
      pos.x = g.fx + (g.tx - g.fx) * m;
      pos.z = g.fz + (g.tz - g.fz) * m;
      yaw = g.fyaw + wrapAngle(g.tyaw - g.fyaw) * e;
      chan.L.target = up ? "talkA" : "sit";
      chan.U.target = up ? (target === "presenting" ? "talkA" : "talkA") : "sit";
      emit(up ? "rising" : "sitting");
    }
    if (p >= 1) {
      pos.x = g.tx;
      pos.z = g.tz;
      loc = g.to;
      if (g.kind === "sit") s = 1;
      if (g.kind === "rise") s = 0;
      seg = null;
    }
  };

  const settle = (dt: number) => {
    if (loc === "seat") {
      chan.L.target = "sit";
      if (target === "greeting" && wavePending) {
        wavePending = false;
        U.wave.time = 0;
        waveT = 0;
      }
      if (waveT >= 0) {
        waveT += dt;
        chan.U.target = "wave";
        if (waveT > U.wave.getClip().duration - 0.35) waveT = -1;
      } else chan.U.target = "sit";
      yaw = approachAngle(yaw, seatYaw, dt * 5);
      emit(paused ? "paused" : target === "greeting" || waveT >= 0 ? "greeting" : "seated");
      return;
    }
    chan.L.target = "talkA";
    const sp = spotOf(loc);
    yaw = approachAngle(yaw, sp.yaw, dt * 4);
    if (loc === "front") {
      talkT += dt;
      chan.U.target = Math.floor(talkT / 6.5) % 2 === 0 ? "talkA" : "talkB";
    } else chan.U.target = "talkA";
    emit(paused ? "paused" : loc === "board" ? "presenting" : loc === "front" ? "speaking" : "standing");
  };

  let speedScale = 1;
  const pointerCam = V();
  const update = (dt: number, pointer: { x: number; y: number }) => {
    if (!seg) plan();
    if (seg) runSeg(dt);
    else settle(dt);
    const moving = !!seg;
    const wantScale = paused && !moving ? 0 : 1;
    speedScale += (wantScale - speedScale) * Math.min(1, dt * 4);
    for (const k of KEYS) {
      if (k === "walk") continue;
      const base = k === "sit" ? 0.7 : 1;
      U[k].timeScale = L[k].timeScale = base * speedScale;
    }
    applyWeights(dt);
    character.rotation.set(0, yaw, 0);
    const standY = talkFloor + (walkFloor - talkFloor) * chan.L.w.walk;
    character.position.set(pos.x, standY + (seatY - standY) * s, pos.z);
    mixer.update(dt);
    applyLegs(s);
    hips.getWorldPosition(pa);
    hostBlob.position.set(pa.x, 0.005, pa.z);
    hostBlob.scale.set(0.36 + s * 0.12, 0.3, 1);

    pointerCam.copy(basePos);
    if (!opts.reducedMotion) {
      pointerCam.x += pointer.x * 0.12;
      pointerCam.y += -pointer.y * 0.07;
    }
    camera.position.lerp(pointerCam, Math.min(1, dt * 3));
    camera.lookAt(look);
    if (stacked) {
      const h = Math.round(viewH * 0.56);
      renderer.setViewport(0, 0, viewW, h);
    } else renderer.setViewport(0, 0, viewW, viewH);
    renderer.render(scene, camera);
  };

  // Initialise mixer state once.
  for (const k of KEYS) {
    U[k].time = 0;
    L[k].time = 0;
  }
  applyWeights(-1);

  return {
    setActivity(a, nonce) {
      if (a === "greeting" && (target !== "greeting" || nonce !== lastNonce)) wavePending = true;
      lastNonce = nonce;
      paused = a === "paused";
      if (!paused) target = a;
    },
    setBoard(page) {
      boardPage = page;
      repaint();
    },
    resize(w, h, isStacked) {
      viewW = w;
      viewH = h;
      stacked = isStacked;
      const fr = isStacked ? stackedFrame : stageFrame;
      corners = fr.corners;
      look.copy(fr.look);
      boardPivot.visible = !isStacked;
      boardBlob.visible = !isStacked;
      renderer.setSize(w, h, false);
      camera.aspect = isStacked ? w / Math.max(1, Math.round(h * 0.56)) : w / h;
      camera.updateProjectionMatrix();
      fit();
    },
    tick: update,
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(character);
      while (disposers.length) disposers.pop()?.();
    },
  };
}
