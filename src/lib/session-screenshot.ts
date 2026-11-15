export type PresentedSurface = {
  source: HTMLVideoElement | HTMLImageElement;
  width: number; height: number; presentedAt: number; identity: string;
};

/** Deliberate, local PNG only: never captures console DOM or uploads a still. */
export async function downloadPresentedScreenshot(options: {
  sessionId: string; authorize(): Promise<void>;
  surface(): PresentedSurface | null; current(): boolean;
}) {
  const first = options.surface();
  const validate = (surface: PresentedSurface | null) => {
    if (!options.current() || !surface || !Number.isFinite(surface.presentedAt) || Date.now() - surface.presentedAt > 3000 ||
        surface.presentedAt > Date.now() + 1000 || !Number.isSafeInteger(surface.width) ||
        !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1 ||
        surface.width * surface.height > 33_177_600 || surface.identity !== first?.identity)
      throw new Error("A fresh, authorized displayed frame is unavailable.");
    return surface;
  };
  validate(first); await options.authorize();
  const surface = validate(options.surface());
  const canvas = document.createElement("canvas");
  canvas.width = surface.width; canvas.height = surface.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG capture is unavailable.");
    context.drawImage(surface.source, 0, 0, surface.width, surface.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error("PNG capture failed.")), "image/png"));
    validate(options.surface()); await options.authorize(); validate(options.surface());
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url;
    link.download = `ConnectLive-${options.sessionId.slice(0,8)}-${new Date().toISOString().replace(/[:.]/g,"-")}.png`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } finally { canvas.width = canvas.height = 0; }
}
