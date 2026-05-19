export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function assertFound<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new HttpError(404, message);
  }
  return value;
}

