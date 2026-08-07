import { timingSafeEqual } from 'node:crypto';

/**
 * Shared-secret authentication for the machine-called drain endpoints.
 *
 * Two problems with the previous `req.nextUrl.searchParams.get('token') !== secret`:
 *
 *   1. THE SECRET WAS IN THE URL. Query strings are written to web-server
 *      access logs, reverse-proxy logs, browser history and `Referer` headers.
 *      A credential that grants the ability to drive the integration should not
 *      be sitting in plaintext in a log file that gets shipped somewhere for
 *      analysis. Headers are not logged by default anywhere in that chain.
 *
 *   2. `!==` ON A SECRET SHORT-CIRCUITS. String comparison returns on the first
 *      differing byte, so the time it takes leaks how much of the prefix was
 *      right. Remote timing attacks over a noisy network are impractical
 *      against a short token, but the cost of doing it properly is one function
 *      call and the code already does it correctly for the HMAC three files
 *      away — there is no reason for the weaker version to exist.
 *
 * Accepts `Authorization: Bearer <token>`, with `X-Drain-Token: <token>` as a
 * fallback for schedulers that cannot set an Authorization header.
 */
export function readDrainToken(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return headers.get('x-drain-token')?.trim() ?? null;
}

/**
 * Constant-time comparison of a presented token against the configured secret.
 *
 * Returns false when the secret is unset, so a deployment that forgot to
 * configure one is closed rather than open — the opposite default would turn a
 * missing env var into an unauthenticated endpoint.
 */
export function drainTokenValid(presented: string | null, secret: string | undefined): boolean {
  if (!secret || !presented) return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  // timingSafeEqual throws on a length mismatch, so the lengths must be
  // compared first. That does leak the token's length, which is not secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Convenience wrapper: reads and validates in one call. */
export function authorizeDrain(headers: Headers, secret: string | undefined): boolean {
  return drainTokenValid(readDrainToken(headers), secret);
}
