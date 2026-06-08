export class KakashiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "KakashiError";
    this.code = code;
    this.details = details;
  }
}

export function isKakashiError(error: unknown): error is KakashiError {
  return error instanceof KakashiError;
}

