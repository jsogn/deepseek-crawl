import { randomBytes } from "node:crypto";
import { GatewayCapacityError } from "./errors.js";

const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const PUBLIC_ID = /^ps_[0-9a-f]{32}$/;

interface SessionEntry {
  upstreamId: string;
  expiresAt: number;
}

export interface AdvancedSessionLease {
  commit(upstreamId: string): string;
  release(): void;
}

export class AdvancedSessionStore {
  readonly #now: () => number;
  readonly #randomHex: () => string;
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, SessionEntry>();
  #reservations = 0;

  constructor(
    options: {
      now?: () => number;
      randomHex?: () => string;
      maxSessions?: number;
      ttlMs?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#randomHex = options.randomHex ?? (() => randomBytes(16).toString("hex"));
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  reserve(): AdvancedSessionLease {
    this.expire();
    if (this.#entries.size + this.#reservations >= this.#maxSessions) {
      throw new GatewayCapacityError("The advanced session capacity is exhausted.", {
        code: "advanced_session_capacity",
        statusCode: 503,
        retryAfterSeconds: 1,
      });
    }
    const createdAt = this.#now();
    this.#reservations += 1;
    let settled = false;
    return {
      commit: (upstreamId: string) => {
        if (settled) {
          throw new Error("Advanced session lease is already settled.");
        }
        settled = true;
        this.#reservations -= 1;
        let publicId = `ps_${this.#randomHex()}`;
        while (!PUBLIC_ID.test(publicId) || this.#entries.has(publicId)) {
          publicId = `ps_${this.#randomHex()}`;
        }
        this.#entries.set(publicId, {
          upstreamId,
          expiresAt: createdAt + this.#ttlMs,
        });
        return publicId;
      },
      release: () => {
        if (!settled) {
          settled = true;
          this.#reservations -= 1;
        }
      },
    };
  }

  resolve(publicId: string): string | undefined {
    this.expire();
    return this.#entries.get(publicId)?.upstreamId;
  }

  remove(publicId: string): boolean {
    return this.#entries.delete(publicId);
  }

  size(): number {
    this.expire();
    return this.#entries.size;
  }

  private expire(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id);
      }
    }
  }
}

export function isPageSiftSessionId(value: string): boolean {
  return PUBLIC_ID.test(value);
}

export function readPageSiftScrapeId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const metadata = (data as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const scrapeId = (metadata as Record<string, unknown>).scrapeId;
  return typeof scrapeId === "string" && scrapeId ? scrapeId : undefined;
}

export function rewritePageSiftScrapeId(
  value: Record<string, unknown>,
  publicId: string,
): Record<string, unknown> {
  const data = value.data;
  const metadata =
    data && typeof data === "object" ? (data as Record<string, unknown>).metadata : undefined;
  if (!metadata || typeof metadata !== "object") {
    return value;
  }
  (metadata as Record<string, unknown>).scrapeId = publicId;
  return value;
}
