/**
 * The request-signing scheme, in one place.
 *
 * Both directions of the CLINIC ↔ POS contract authenticate the same way:
 * HMAC-SHA256 over `${X-Timestamp}.${rawBody}`, hex, verified against the RAW
 * body before anything parses it, inside a five-minute replay window.
 *
 * Extracted from webhook-handler.ts when the pull endpoints were added rather
 * than copied into them. Two implementations of an auth check is how one of
 * them quietly stops matching the other — and the one that drifts is the one
 * nobody is looking at.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Constant-time signature check. Returns false on any mismatch.
 *
 * Compares the hex STRINGS rather than the decoded bytes, deliberately: a
 * length check plus timingSafeEqual on equal-length buffers is what the
 * original implementation did, and the webhook suite's forgery tests are
 * written against that behaviour.
 */
export function verifySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  provided: string,
): boolean {
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sign a body the way a caller must. Used by the tests, and by any client
 *  written in this repo, so the sender and the verifier cannot disagree. */
export function signBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Replay protection. An unparseable timestamp is stale, not fresh — Date.parse
 *  returns NaN there, and NaN comparisons are false, so the check is written to
 *  reject explicitly rather than fall through. */
export function isFreshTimestamp(timestamp: string, now: number = Date.now()): boolean {
  const skew = Math.abs(now - Date.parse(timestamp));
  return !Number.isNaN(skew) && skew <= MAX_CLOCK_SKEW_MS;
}

/**
 * The shared front door: header presence, freshness, signature. Returns null
 * when the request is authentic, or the Response to send when it is not.
 *
 * Returning the rejection rather than throwing keeps the "a rejected request
 * must not touch the database" property that the webhook tests assert — the
 * caller returns immediately and never reaches its deps.
 */
export function rejectIfUnauthentic(
  request: Request,
  rawBody: string,
  secret: string,
): Response | null {
  const timestamp = request.headers.get('X-Timestamp');
  const signature = request.headers.get('X-Signature');

  if (!timestamp || !signature) {
    return Response.json({ error: 'missing signature headers' }, { status: 401 });
  }
  if (!isFreshTimestamp(timestamp)) {
    return Response.json({ error: 'stale timestamp' }, { status: 401 });
  }
  if (!verifySignature(secret, timestamp, rawBody, signature)) {
    return Response.json({ error: 'bad signature' }, { status: 401 });
  }
  return null;
}
