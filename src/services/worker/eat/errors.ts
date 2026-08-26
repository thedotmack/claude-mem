export type EatErrorCode = 'invalid_request' | 'payload_too_large' | 'upstream_fetch_failed' | 'digest_failed';

const STATUS_BY_CODE: Record<EatErrorCode, number> = {
  invalid_request: 400,
  payload_too_large: 413,
  upstream_fetch_failed: 502,
  digest_failed: 502,
};

/**
 * Structured EAT failure carrying a memorable-style error code. EatRoutes maps
 * these to `{ error: <code>, detail, request_id }` JSON bodies; anything else
 * stays an unexpected 500 via wrapHandler.
 */
export class EatError extends Error {
  constructor(
    public readonly code: EatErrorCode,
    detail: string
  ) {
    super(detail);
    this.name = 'EatError';
  }

  get statusCode(): number {
    return STATUS_BY_CODE[this.code];
  }
}
