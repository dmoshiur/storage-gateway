export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  /**
   * Internal machine-readable context for server logs and trusted callers.
   * `failure()` deliberately does not serialize this field because dependency
   * messages can contain infrastructure details.
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
