export type ErrorCode =
  | "BAD_REQUEST"
  | "CONTENT_REJECTED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SETUP_REQUIRED"
  | "PROVIDER_TRANSIENT"
  | "PROVIDER_REJECTED"
  | "PROVIDER_AMBIGUOUS"
  | "SCHEMA_DRIFT"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL", "Something went wrong. Please try again.", {
    status: 500,
    retryable: true,
    cause: error,
  });
}
