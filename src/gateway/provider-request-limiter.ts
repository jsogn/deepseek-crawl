import type { DeepSeekGateway } from "../deepseek/gateway.js";
import type { FetchInput, RawFetchResponse, RawSearchResponse, SearchInput } from "../types.js";

interface QueueEntry {
  resolve(): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export class ProviderRequestLimiter {
  readonly #maxConcurrent: number;
  readonly #queue: QueueEntry[] = [];
  #active = 0;

  constructor(maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("Maximum concurrent provider requests must be at least 1.");
    }
    this.#maxConcurrent = maxConcurrent;
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.#active, queued: this.#queue.length };
  }

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    await this.#acquire(signal);
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        entry.onAbort = () => {
          const index = this.#queue.indexOf(entry);
          if (index !== -1) {
            this.#queue.splice(index, 1);
          }
          reject(abortError(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
      if (signal?.aborted) {
        entry.onAbort?.();
      }
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (!next) {
      this.#active = Math.max(0, this.#active - 1);
      return;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.resolve();
  }
}

export class LimitedDeepSeekGateway implements DeepSeekGateway {
  readonly #client: () => DeepSeekGateway;
  readonly #limiter: ProviderRequestLimiter;

  constructor(client: () => DeepSeekGateway, limiter: ProviderRequestLimiter) {
    this.#client = client;
    this.#limiter = limiter;
  }

  search(input: SearchInput, signal?: AbortSignal): Promise<RawSearchResponse> {
    return this.#limiter.run(signal, () => this.#client().search(input, signal));
  }

  fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse> {
    return this.#limiter.run(signal, () => this.#client().fetch(input, signal));
  }
}
