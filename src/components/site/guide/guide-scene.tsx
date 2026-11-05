import { useEffect, useRef, useState } from "react";
import { guideAssets } from "./guide-assets";
import type { GuideAnimationId } from "./guide-knowledge";
import type { GuideActivity, GuideBoardPage } from "./guide-contract";
import type { StageApi } from "./guide-stage-engine";
import "./guide-stage.css";

/** Legacy export kept so older callers still type-check during migration. */
export type GuideSceneAnimation = "sit" | "wave" | "talk" | "talk-alt";
export function toSceneAnimation(id: GuideAnimationId): GuideSceneAnimation {
  return id === "wave" ? "wave" : id === "talk_open" ? "talk" : id === "talk_raised" ? "talk-alt" : "sit";
}

type Disposable = { dispose: () => void };
type MeshLike = { isMesh?: boolean; geometry?: Disposable; material?: unknown };
type Traversable = { traverse: (fn: (obj: unknown) => void) => void };

function disposeTree(root: Traversable) {
  root.traverse((obj) => {
    const mesh = obj as MeshLike;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as (Disposable | null)[];
    for (const mat of mats) {
      if (!mat) continue;
      for (const value of Object.values(mat)) {
        if (value && (value as { isTexture?: boolean }).isTexture) (value as unknown as Disposable).dispose();
      }
      mat.dispose();
    }
  });
}

const STACK_BELOW = 600;

export type GuideSceneProps = {
  activity: GuideActivity;
  board: GuideBoardPage;
  nonce: number;
  onReady?: () => void;
  onError?: () => void;
  onActivityChange?: (phase: string) => void;
};

export function GuideScene({ activity, board, nonce, onReady, onError, onActivityChange }: GuideSceneProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<StageApi | null>(null);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState("seated");
  const [stacked, setStacked] = useState(false);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onPhaseRef = useRef(onActivityChange);
  onPhaseRef.current = onActivityChange;
  const latest = useRef({ activity, board, nonce });
  latest.current = { activity, board, nonce };

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas) return;
    let disposed = false;
    const teardown: (() => void)[] = [];
    let tornDown = false;
    const disposeAll = () => {
      if (tornDown) return;
      tornDown = true;
      while (teardown.length) {
        try {
          teardown.pop()?.();
        } catch {
          /* keep releasing the rest */
        }
      }
    };

    const start = async () => {
      try {
        const THREE = await import("three");
        const [{ GLTFLoader }, { MeshoptDecoder }, { RoomEnvironment }, { buildStage }] = await Promise.all([
          import("three/examples/jsm/loaders/GLTFLoader.js"),
          import("three/examples/jsm/libs/meshopt_decoder.module.js"),
          import("three/examples/jsm/environments/RoomEnvironment.js"),
          import("./guide-stage-engine"),
        ]);
        if (disposed) return;

        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
        teardown.push(() => {
          renderer.dispose();
          renderer.forceContextLoss();
        });
        const maxDpr = Math.min(window.devicePixelRatio || 1, 1.5);
        let dpr = maxDpr;
        renderer.setPixelRatio(dpr);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.setClearColor(0x000000, 0);

        const scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(renderer);
        teardown.push(() => pmrem.dispose());
        const room = new RoomEnvironment();
        teardown.push(() => disposeTree(room as unknown as Traversable));
        const envTarget = pmrem.fromScene(room, 0.04);
        teardown.push(() => envTarget.dispose());
        scene.environment = envTarget.texture;
        scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x0b0f18, 0.85));
        const key = new THREE.DirectionalLight(0xfff4ea, 2.0);
        key.position.set(3, 4, 5);
        const rim = new THREE.DirectionalLight(0x6ea8ff, 2.4);
        rim.position.set(-4, 2.5, -4);
        scene.add(key, rim);

        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const [characterGltf, couchGltf, boardGltf] = await Promise.all([
          loader.loadAsync(guideAssets.characterUrl),
          loader.loadAsync(guideAssets.couchUrl),
          loader.loadAsync(guideAssets.boardUrl),
        ]);
        const roots = [characterGltf.scene, couchGltf.scene, boardGltf.scene];
        if (disposed) {
          roots.forEach((r) => disposeTree(r));
          return;
        }
        teardown.push(() => roots.forEach((r) => disposeTree(r)));
        if (document.fonts?.ready) await document.fonts.ready.catch(() => undefined);
        if (disposed) {
          disposeAll();
          return;
        }

        const font = getComputedStyle(shell).fontFamily || "system-ui, sans-serif";
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const stage = buildStage({
          THREE,
          renderer,
          scene,
          character: characterGltf.scene,
          clips: characterGltf.animations,
          couch: couchGltf.scene,
          board: boardGltf.scene,
          font,
          reducedMotion,
          onPhase: (p) => {
            if (tornDown) return;
            setPhase(p);
            onPhaseRef.current?.(p);
          },
        });
        teardown.push(() => stage.dispose());
        stage.setActivity(latest.current.activity, latest.current.nonce);
        stage.setBoard(latest.current.board);

        const resize = () => {
          const w = shell.clientWidth || 1;
          const h = shell.clientHeight || 1;
          const isStacked = w < STACK_BELOW;
          setStacked(isStacked);
          stage.resize(w, h, isStacked);
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(shell);
        teardown.push(() => ro.disconnect());

        const pointer = { x: 0, y: 0 };
        const onPointer = (e: PointerEvent) => {
          const r = shell.getBoundingClientRect();
          pointer.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
          pointer.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
        };
        const onLeave = () => {
          pointer.x = 0;
          pointer.y = 0;
        };
        shell.addEventListener("pointermove", onPointer, { passive: true });
        shell.addEventListener("pointerleave", onLeave, { passive: true });
        teardown.push(() => {
          shell.removeEventListener("pointermove", onPointer);
          shell.removeEventListener("pointerleave", onLeave);
        });

        let inView = true;
        let frame = 0;
        let first = true;
        let slowAvg = 1 / 60;
        let frames = 0;
        const clock = new THREE.Clock();
        const tick = () => {
          frame = 0;
          if (tornDown || !inView || document.visibilityState !== "visible") return;
          // Clamp long frames so walking never jumps across the room.
          const dt = clock.getDelta();
          // Time-based motion: clamp only pathological stalls so slow GPUs still progress in real time.
          stage.tick(Math.min(dt, 0.25), pointer);
          // Adaptive resolution: sustained slow frames drop the framebuffer DPR.
          slowAvg = slowAvg * 0.9 + dt * 0.1;
          if (++frames > 30 && slowAvg > 1 / 30 && dpr > 0.75) {
            dpr = Math.max(0.75, dpr - 0.25);
            renderer.setPixelRatio(dpr);
            resize();
            frames = 0;
          }
          if (first) {
            first = false;
            setReady(true);
            onReadyRef.current?.();
          }
          frame = requestAnimationFrame(tick);
        };
        teardown.push(() => {
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
        });
        const resume = () => {
          if (!tornDown && !frame && inView && document.visibilityState === "visible") {
            clock.getDelta();
            frame = requestAnimationFrame(tick);
          }
        };
        const io = new IntersectionObserver(
          (entries) => {
            inView = entries.some((entry) => entry.isIntersecting);
            if (inView) resume();
          },
          { rootMargin: "80px" },
        );
        io.observe(shell);
        teardown.push(() => io.disconnect());
        const onVisibility = () => resume();
        document.addEventListener("visibilitychange", onVisibility);
        teardown.push(() => document.removeEventListener("visibilitychange", onVisibility));

        stageRef.current = stage;
        teardown.push(() => {
          stageRef.current = null;
        });
        resume();
      } catch (err) {
        if (!disposed) {
          console.warn("[guide] 3D stage unavailable", err);
          disposeAll();
          onErrorRef.current?.();
        }
      }
    };

    start();
    return () => {
      disposed = true;
      disposeAll();
    };
  }, []);

  useEffect(() => {
    stageRef.current?.setActivity(activity, nonce);
  }, [activity, nonce, ready]);

  const boardKey = `${board.heading}\u0001${board.words.join("\u0002")}\u0001${board.activeWord}\u0001${board.page}/${board.pages}\u0001${board.status}`;
  useEffect(() => {
    stageRef.current?.setBoard(latest.current.board);
  }, [boardKey, ready]);

  return (
    <div
      ref={shellRef}
      className="gd-shell"
      data-ready={ready ? "true" : "false"}
      data-activity={activity}
      data-phase={phase}
      data-layout={stacked ? "stacked" : "stage"}
      data-board-page={`${board.page}/${board.pages}`}
      data-board-active={board.activeWord}
      data-testid="guide-stage"
    >
      <img
        className="gd-poster"
        src={guideAssets.portraitSeatedUrl}
        alt="ConnectLive virtual guide, seated in the lounge beside her presentation board"
        loading="lazy"
        decoding="async"
      />
      <canvas ref={canvasRef} className="gd-canvas" aria-hidden="true" />
      <section className="gd-stage-board" aria-label="Guide board" data-testid="guide-board">
        <h3 data-testid="text-board-heading">{board.heading}</h3>
        <ol data-testid="text-board-words">
          {board.words.map((w, i) => (
            <li key={`${i}-${w}`}>
              <span
                className="gd-w"
                data-state={board.activeWord < 0 || i < board.activeWord ? "said" : i === board.activeWord ? "active" : "upcoming"}
                aria-current={i === board.activeWord ? "true" : undefined}
              >
                {w}
              </span>{" "}
            </li>
          ))}
        </ol>
        <footer>
          <span data-testid="status-board">{board.status}</span>
          {board.pages > 0 && (
            <span data-testid="text-board-page">
              Page {board.page} of {board.pages}
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}
