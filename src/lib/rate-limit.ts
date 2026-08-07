/**
 * Fixed-window rate limiting.
 *
 * ── HONEST SCOPE ──────────────────────────────────────────────────────────
 * This is in-process memory. That means:
 *
 *   · counters reset when the server restarts
 *   · every instance keeps its own counters, so N instances allow N× the limit
 *
 * For a single-clinic deployment — one Next.js process on one machine — that is
 * the whole system and the limiter is exact. On a multi-instance host it is a
 * speed bump, not a control. It is written this way deliberately rather than
 * pulling in Redis for a deployment that does not have one, but the moment this
 * runs on more than one instance the store must move (swap `hits` for a Redis
 * INCR with TTL; nothing else changes).
 *
 * Documented here rather than discovered later, because a rate limiter people
 * believe in but that does not work is worse than none: it stops anyone from
 * asking whether the real control exists.
 *
 * A fixed window (rather than a sliding one) can allow up to 2× the limit
 * across a window boundary. For "slow down credential stuffing" that is
 * irrelevant, and the implementation is small enough to audit at a glance.
 */

interface Bucket {
  count: number;
  /** Epoch ms at which this window ends. */
  resetAt: number;
}

const hits = new Map<string, Bucket>();

/** Stops the map growing without bound from one-off keys. */
const MAX_KEYS = 10_000;

export interface RateLimitResult {
  ok: boolean;
  /** Requests still allowed in this window. */
  remaining: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
  /** Seconds until reset — the value for a Retry-After header. */
  retryAfter: number;
}

/**
 * Records a hit against `key` and reports whether it is allowed.
 *
 * @param key    what is being limited — include the actor AND the action, so a
 *               login attempt cannot consume a patient-search budget
 * @param limit  requests permitted per window
 * @param windowMs window length in milliseconds
 * @param now    injectable clock; the tests would otherwise have to sleep
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const existing = hits.get(key);

  if (!existing || now >= existing.resetAt) {
    // Sweep on write rather than on a timer: no background work, and the cost
    // is paid by whoever is generating the keys.
    if (hits.size >= MAX_KEYS) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
      // Still full means the pressure is live traffic, not stale entries.
      // Dropping the oldest is preferable to unbounded growth.
      if (hits.size >= MAX_KEYS) hits.clear();
    }
    const bucket = { count: 1, resetAt: now + windowMs };
    hits.set(key, bucket);
    // The limit is consulted even on the first request of a window. Returning
    // an unconditional `ok` here would let a limit of 0 — the natural way to
    // disable an endpoint — still admit one request per key per window.
    const allowed = bucket.count <= limit;
    return {
      ok: allowed,
      remaining: Math.max(0, limit - 1),
      resetAt: bucket.resetAt,
      retryAfter: allowed ? 0 : Math.ceil(windowMs / 1000),
    };
  }

  existing.count += 1;
  const remaining = Math.max(0, limit - existing.count);
  const ok = existing.count <= limit;

  return {
    ok,
    remaining,
    resetAt: existing.resetAt,
    retryAfter: ok ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  };
}

/** Clears all counters. Test-only — never call this from a request path. */
export function resetRateLimits(): void {
  hits.clear();
}

/**
 * The 429 response for a rejected request.
 *
 * `Retry-After` is set because a well-behaved scheduler will honour it, and a
 * caller that backs off correctly is one that stops adding load.
 */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfter),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
      },
    },
  );
}

/**
 * Best-effort client identity for rate-limit keys.
 *
 * `x-forwarded-for` is trivially spoofable unless a trusted proxy sets it, so
 * this is NOT an authorization input and must never be used as one. It is only
 * ever a bucket label: a spoofing attacker fragments their own bucket and
 * bypasses the limit, which is exactly why anything that matters is keyed on
 * the authenticated user id instead, and IP is reserved for pre-auth routes
 * where no better identifier exists.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
