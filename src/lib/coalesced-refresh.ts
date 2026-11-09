/** At most one read in flight and one trailing refresh for a burst of events. */
export function createCoalescedRefresh(
  work: (signal: AbortSignal) => Promise<void>,
  onError: () => void,
  delayMs = 250,
) {
  let running: Promise<void> | null = null;
  let trailing = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  const request = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) { trailing = true; return running; }
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller = new AbortController();
    const signal = controller.signal;
    const current = controller;
    let deadline: ReturnType<typeof setTimeout>;
    running = Promise.race([
      Promise.resolve().then(() => work(signal)),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => { current.abort(); reject(new Error("Refresh deadline")); }, 12_000);
      }),
    ]).catch(() => {
      if (!stopped) onError();
    }).finally(() => {
      clearTimeout(deadline);
      running = null;
      if (trailing && !stopped) {
        trailing = false;
        timer = setTimeout(() => { timer = null; void request(); }, delayMs);
      }
    });
    return running;
  };
  return {
    request,
    stop() {
      stopped = true;
      controller?.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
