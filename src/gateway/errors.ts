export class UnsupportedFallbackFeatureError extends Error {
  readonly code = "unsupported_fallback_feature";

  constructor(message = "This Firecrawl option is not supported by the DeepSeek fallback.") {
    super(message);
    this.name = "UnsupportedFallbackFeatureError";
  }
}

export class GatewayNotFoundError extends Error {
  constructor(message = "The requested gateway resource was not found.") {
    super(message);
    this.name = "GatewayNotFoundError";
  }
}

export class GatewayInvalidRequestError extends Error {
  readonly code = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "GatewayInvalidRequestError";
  }
}

export class GatewayCapacityError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: { code: string; statusCode: number; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "GatewayCapacityError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}
