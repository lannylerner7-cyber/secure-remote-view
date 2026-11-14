/** Optional metadata only. Never use this deadline/result for authorization,
 * process fencing, license checks, commands or session lifecycle writes. */
export const TELEMETRY_WRITE_BUDGET_MS = 1_000;

export async function writeBoundedTelemetry(
  parent: AbortSignal,
  write: (signal: AbortSignal) => PromiseLike<{ error: unknown }>,
): Promise<boolean> {
  if (parent.aborted) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const cancelled = new Promise<boolean>(resolve => {
    stop = () => { controller.abort(); resolve(false); };
    parent.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, TELEMETRY_WRITE_BUDGET_MS);
  });
  // Observe even a late failure. Neither a stalled fetch nor a thrown SDK
  // error may turn optional reporting into a lost-authority heartbeat.
  const result = Promise.resolve().then(() => {
    if (controller.signal.aborted) return false;
    return Promise.resolve(write(controller.signal)).then(value => !value.error);
  }).catch(() => false);
  try {
    return await Promise.race([result, cancelled]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", stop);
  }
}
