/** Sequential status GETs only. This helper must never wrap an unlock action. */
export function createStatusPoll(run: (signal: AbortSignal) => Promise<number | null>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let abort: AbortController | null = null;
  function request(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    abort = new AbortController();
    const signal = abort.signal;
    let next: number | null = null;
    running = Promise.resolve().then(() => run(signal)).then(delay => { next = delay; })
      .catch(() => { next = 60_000; })
      .finally(() => {
        running = null;
        if (!stopped && next !== null) timer = setTimeout(() => { void request(); }, next);
      });
    return running;
  }
  return {
    request,
    stop() { stopped = true; abort?.abort(); if (timer !== null) clearTimeout(timer); timer = null; },
  };
}

export function unlockStatusPollDelay(options: {
  failures: number; status?: number; enabled?: boolean; helperReady?: boolean;
}): number | null {
  if ([401, 403, 404, 410].includes(options.status ?? 0)) return null;
  if (options.failures > 0) return Math.max(
    options.status === 429 ? 60_000 : 15_000,
    Math.min(120_000, 15_000 * 2 ** Math.min(3, options.failures - 1)),
  );
  return options.enabled && options.helperReady ? 5000 : 30_000;
}
