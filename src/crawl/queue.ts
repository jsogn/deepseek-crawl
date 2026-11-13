export interface LayeredTaskOptions<T, R> {
  concurrency: number;
  delayMs: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  run: (item: T, index: number) => Promise<R>;
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runLayeredTasks<T, R>(
  items: readonly T[],
  options: LayeredTaskOptions<T, R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let startGate = Promise.resolve();
  let nextStartAt = 0;

  const start = async (): Promise<void> => {
    let release: () => void = () => undefined;
    const previous = startGate;
    startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      options.signal?.throwIfAborted();
      const remaining = Math.max(0, nextStartAt - Date.now());
      if (remaining > 0) {
        await (options.sleep ?? defaultWait)(remaining, options.signal);
      }
      nextStartAt = Date.now() + options.delayMs;
    } finally {
      release();
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await start();
      options.signal?.throwIfAborted();
      const item = items[index];
      if (item === undefined) return;
      results[index] = await options.run(item, index);
    }
  };

  const workers = Array.from({ length: Math.min(options.concurrency, items.length) }, () =>
    worker(),
  );
  try {
    await Promise.all(workers);
  } catch (error) {
    await Promise.allSettled(workers);
    throw error;
  }
  return results;
}
