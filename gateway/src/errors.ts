/**
 * One error vocabulary for everything the gateway returns, in OpenAI's error shape:
 *   { "error": { "message", "type", "code", "request_id" } }
 */
export type ErrorCode =
  | "invalid_request"
  | "context_length_exceeded"
  | "model_not_found"
  | "overloaded"
  | "upstream_timeout"
  | "upstream_unavailable"
  | "upstream_error"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  context_length_exceeded: 400,
  model_not_found: 404,
  overloaded: 429,
  upstream_timeout: 504,
  upstream_unavailable: 503,
  upstream_error: 502,
  internal_error: 500,
};

const TYPE: Record<ErrorCode, string> = {
  invalid_request: "invalid_request_error",
  context_length_exceeded: "invalid_request_error",
  model_not_found: "invalid_request_error",
  overloaded: "rate_limit_error",
  upstream_timeout: "server_error",
  upstream_unavailable: "server_error",
  upstream_error: "server_error",
  internal_error: "server_error",
};

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to try again on another attempt (only ever done before the first byte is sent). */
  readonly retryable: boolean;
  readonly retryAfterS: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; retryAfterS?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "GatewayError";
    this.code = code;
    this.status = STATUS[code];
    this.retryable = opts.retryable ?? false;
    this.retryAfterS = opts.retryAfterS;
  }
}

export function errorBody(err: GatewayError, requestId: string) {
  return {
    error: { message: err.message, type: TYPE[err.code], code: err.code, request_id: requestId },
  };
}

/** Marker reason used when the client disconnects; never turned into a response. */
export class ClientAbortError extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientAbortError";
  }
}

const CONTEXT_LENGTH_RE =
  /maximum context length|context length|too many tokens|prompt is too long/i;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Maps a non-2xx upstream response to a gateway error. */
export function fromUpstreamStatus(status: number, bodyText: string): GatewayError {
  const message = extractMessage(bodyText) ?? `upstream returned HTTP ${status}`;
  if (status === 404) return new GatewayError("model_not_found", message);
  if (status >= 400 && status < 500 && status !== 429) {
    if (CONTEXT_LENGTH_RE.test(message))
      return new GatewayError("context_length_exceeded", message);
    return new GatewayError("invalid_request", message);
  }
  const retryable = RETRYABLE_STATUS.has(status);
  const code = status === 429 || status === 503 ? "upstream_unavailable" : "upstream_error";
  return new GatewayError(code, message, { retryable });
}

function extractMessage(bodyText: string): string | undefined {
  try {
    const body = JSON.parse(bodyText) as {
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error.message === "string") return body.error.message;
  } catch {
    // not JSON
  }
  const trimmed = bodyText.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/** Connection-level failure talking to the upstream (no HTTP status). */
export function isNetworkError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
