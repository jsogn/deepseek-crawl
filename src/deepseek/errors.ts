export type DeepSeekErrorKind =
  | "config"
  | "invalid_request"
  | "auth"
  | "balance"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "cancelled"
  | "resource_limit"
  | "invalid_response";

export interface DeepSeekErrorOptions {
  kind: DeepSeekErrorKind;
  status?: number;
  requestId?: string;
  cause?: unknown;
}

export class DeepSeekError extends Error {
  readonly kind: DeepSeekErrorKind;
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, options: DeepSeekErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DeepSeekError";
    this.kind = options.kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.requestId !== undefined) {
      this.requestId = options.requestId;
    }
  }
}
