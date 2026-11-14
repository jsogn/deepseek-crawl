export interface AuthLimiterCheck {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface AuthFailureLimiterOptions {
  failureLimit?: number;
  windowMs?: number;
  blockMs?: number;
  now?: () => number;
}

interface ClientFailures {
  failures: number[];
  blockedUntil: number;
}

export class AuthFailureLimiter {
  readonly #failureLimit: number;
  readonly #windowMs: number;
  readonly #blockMs: number;
  readonly #now: () => number;
  readonly #clients = new Map<string, ClientFailures>();

  constructor(options: AuthFailureLimiterOptions = {}) {
    this.#failureLimit = options.failureLimit ?? 5;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#blockMs = options.blockMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  check(client: string): AuthLimiterCheck {
    const now = this.#now();
    const current = this.#clients.get(client);
    if (!current) {
      return { allowed: true };
    }
    if (current.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((current.blockedUntil - now) / 1000),
      };
    }
    current.blockedUntil = 0;
    current.failures = current.failures.filter((timestamp) => timestamp > now - this.#windowMs);
    if (current.failures.length === 0) {
      this.#clients.delete(client);
    }
    return { allowed: true };
  }

  failure(client: string): AuthLimiterCheck {
    const now = this.#now();
    const current = this.#clients.get(client) ?? {
      failures: [],
      blockedUntil: 0,
    };
    current.failures = current.failures.filter((timestamp) => timestamp > now - this.#windowMs);
    current.failures.push(now);
    if (current.failures.length >= this.#failureLimit) {
      current.blockedUntil = now + this.#blockMs;
      current.failures = [];
      this.#clients.set(client, current);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(this.#blockMs / 1000),
      };
    }
    this.#clients.set(client, current);
    return { allowed: true };
  }

  success(client: string): void {
    this.#clients.delete(client);
  }
}
