import { useEffect, useRef, useState } from "react";
import fallbackPoster from "@/assets/connectlive-session-core.png";
import { sessionCoreAssets } from "./session-core-assets";
import "./session-core.css";

type CoreState = "poster" | "loading" | "ready" | "error" | "static";

function prefersStatic() {
  if (typeof window === "undefined") return true;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  if (window.matchMedia("(prefers-reduced-data: reduce)").matches) return true;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return true;
  try {
    const probe = document.createElement("canvas");
    const gl = (probe.getContext("webgl2") || probe.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return true;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    probe.width = 0;
    probe.height = 0;
    return false;
  } catch {
    return true;
  }
}

type Disposable = { dispose: () => void };
type MeshLike = { isMesh?: boolean; geometry?: Disposable; material?: unknown };
type Traversable = { traverse: (fn: (obj: unknown) => void) => void };

/** Releases every geometry, material and texture under an object tree. */
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

export function SessionCore({ compact = false }: { compact?: boolean }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<CoreState>("poster");
  const poster = sessionCoreAssets.posterUrl || fallbackPoster;

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas || !sessionCoreAssets.modelUrl) return;
    if (prefersStatic()) {
      setState("static");
      return;
    }
    let disposed = false;
    // Idempotent teardown steps, registered the moment each resource exists.
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
      setState("loading");
      try {
        const THREE = await import("three");
        const [{ GLTFLoader }, { MeshoptDecoder }, { RoomEnvironment }] = await Promise.all([
          import("three/examples/jsm/loaders/GLTFLoader.js"),
          import("three/examples/jsm/libs/meshopt_decoder.module.js"),
          import("three/examples/jsm/environments/RoomEnvironment.js"),
        ]);
        if (disposed) return;

        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
        teardown.push(() => {
          renderer.dispose();
          renderer.forceContextLoss();
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.setClearColor(0x000000, 0);

        const scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(renderer);
        teardown.push(() => pmrem.dispose());
        const room = new RoomEnvironment();
        teardown.push(() => {
          const withDispose = room as unknown as { dispose?: () => void };
          if (typeof withDispose.dispose === "function") withDispose.dispose();
          else disposeTree(room);
        });
        const envTarget = pmrem.fromScene(room, 0.04);
        teardown.push(() => envTarget.dispose());
        scene.environment = envTarget.texture;

        scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x0b0f18, 0.7));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 4, 5);
        const rim = new THREE.DirectionalLight(0x6ea8ff, 2.6);
        rim.position.set(-4, 2, -4);
        const fill = new THREE.PointLight(0xa9cbff, 1.4, 0, 2);
        fill.position.set(0, -2, 3);
        scene.add(key, rim, fill);

        const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(sessionCoreAssets.modelUrl);
        const model = gltf.scene;
        teardown.push(() => disposeTree(model));
        if (disposed) {
          // Unmounted while loading: release the late-arriving model too.
          disposeAll();
          return;
        }

        const box = new THREE.Box3().setFromObject(model);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = sphere.radius || 1;
        model.position.sub(sphere.center);
        const pivot = new THREE.Group();
        pivot.add(model);
        pivot.scale.setScalar(1 / radius);
        scene.add(pivot);
        const dist = (1 / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.08;
        camera.position.set(0, 0.12, dist);
        camera.lookAt(0, 0, 0);

        const resize = () => {
          const w = shell.clientWidth || 1;
          const h = shell.clientHeight || 1;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(shell);
        teardown.push(() => ro.disconnect());

        const target = { x: 0, y: 0 };
        const onPointer = (e: PointerEvent) => {
          const r = shell.getBoundingClientRect();
          target.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
          target.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
        };
        const onLeave = () => {
          target.x = 0;
          target.y = 0;
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
        const clock = new THREE.Clock();
        const tick = () => {
          frame = 0;
          if (tornDown || !inView || document.visibilityState !== "visible") return;
          const t = clock.getElapsedTime();
          pivot.position.y = Math.sin(t * 1.05) * 0.035;
          pivot.rotation.y += (target.x * 0.32 + Math.sin(t * 0.35) * 0.22 - pivot.rotation.y) * 0.05;
          pivot.rotation.x += (target.y * 0.16 + Math.sin(t * 0.5) * 0.04 - pivot.rotation.x) * 0.05;
          renderer.render(scene, camera);
          if (first) {
            first = false;
            setState("ready");
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
        const io = new IntersectionObserver((entries) => {
          inView = entries[0]?.isIntersecting ?? false;
          resume();
        });
        io.observe(shell);
        document.addEventListener("visibilitychange", resume);
        teardown.push(() => {
          io.disconnect();
          document.removeEventListener("visibilitychange", resume);
        });
        const onLost = (e: Event) => {
          e.preventDefault();
          setState("error");
          disposeAll();
        };
        canvas.addEventListener("webglcontextlost", onLost);
        teardown.push(() => canvas.removeEventListener("webglcontextlost", onLost));
        resume();
      } catch {
        disposeAll();
        if (!disposed) setState("error");
      }
    };

    // Defer the 3D download until the hero is near the viewport.
    const gate = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          gate.disconnect();
          void start();
        }
      },
      { rootMargin: "200px" },
    );
    gate.observe(shell);

    return () => {
      disposed = true;
      gate.disconnect();
      disposeAll();
    };
  }, []);

  return (
    <div
      ref={shellRef}
      className={`orb-shell sc-shell ${compact ? "max-w-md" : ""}`}
      role="img"
      aria-label="Illustration of an authorized live support session"
      data-testid="hero-session-core"
      data-state={state}
    >
      <div className="orb-ring" aria-hidden="true" />
      <div className="sc-stage" aria-hidden="true">
        <img className="orb-image" src={poster} alt="" decoding="async" data-testid="img-session-core-poster" />
      </div>
      <canvas ref={canvasRef} className="sc-canvas" aria-hidden="true" data-testid="canvas-session-core-model" />
      <div className="orbit-label orbit-one">
        <span>Transport</span>
        <strong>Encrypted</strong>
      </div>
      <div className="orbit-label orbit-two">
        <span>Device</span>
        <strong>Authorized</strong>
      </div>
      <div className="orbit-label orbit-three">
        <span>Channel</span>
        <strong>WebRTC</strong>
      </div>
    </div>
  );
}
