import { chmod, type FileHandle, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

export interface RotatingLogFileOptions {
  maxBytes?: number;
  maxFiles?: number;
}

export class RotatingLogFileWriter {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  #handle: FileHandle | undefined;
  #size = 0;
  #queue = Promise.resolve();
  #closed = false;

  constructor(path: string, options: RotatingLogFileOptions = {}) {
    this.#path = path;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new Error("Gateway log maxBytes must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maxFiles) || this.#maxFiles < 1) {
      throw new Error("Gateway log maxFiles must be a positive integer.");
    }
  }

  write(value: string): void {
    if (this.#closed) {
      return;
    }
    this.#queue = this.#queue.then(() => this.#append(value)).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#queue;
      return;
    }
    this.#closed = true;
    await this.#queue;
    await this.#handle?.close().catch(() => undefined);
    this.#handle = undefined;
  }

  async #append(value: string): Promise<void> {
    await this.#ensureOpen();
    const bytes = Buffer.byteLength(value);
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
      await this.#rotate();
    }
    await this.#handle?.write(value);
    this.#size += bytes;
  }

  async #ensureOpen(): Promise<void> {
    if (this.#handle) {
      return;
    }
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#handle = await open(this.#path, "a", 0o600);
    await chmod(this.#path, 0o600);
    this.#size = (await stat(this.#path)).size;
  }

  async #rotate(): Promise<void> {
    await this.#handle?.close();
    this.#handle = undefined;

    if (this.#maxFiles > 1) {
      await rm(`${this.#path}.${this.#maxFiles - 1}`, { force: true });
      for (let index = this.#maxFiles - 2; index >= 1; index -= 1) {
        await rename(`${this.#path}.${index}`, `${this.#path}.${index + 1}`).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        });
      }
      await rename(this.#path, `${this.#path}.1`).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
    } else {
      await rm(this.#path, { force: true });
    }
    this.#size = 0;
    await this.#ensureOpen();
  }
}
