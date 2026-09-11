export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  /**
   * Machine-readable context about *why* the request failed: the underlying
   * dependency error code/message, whether a retry can succeed, and an
   * operator hint. This is what keeps a 503 from being an opaque
   * "something went wrong" — the real cause travels with the response
   * (never credentials, never tokens; see `describeFailure`).
   */
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
