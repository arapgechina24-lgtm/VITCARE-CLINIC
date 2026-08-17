import { supabaseService } from '@/lib/supabase/server';
import { handlePosFetch } from '@/modules/prescriptions/integration/pull-handler';
import { makePullDeps } from '@/lib/integration/pull-deps';
import { rateLimit, clientKey, tooManyRequests } from '@/lib/rate-limit';

// HMAC verification uses node:crypto, which the edge runtime does not provide.
export const runtime = 'nodejs';
/** Never cached — the queue changes between polls, and a cached empty page
 *  would stall the pharmacy while looking perfectly healthy. */
export const dynamic = 'force-dynamic';

/**
 * POST /api/integration/pos/outbox/fetch
 *
 * The till collects prescriptions from here instead of the clinic pushing them,
 * because the till publishes no inbound door to the internet — see the design
 * note at the top of pull-handler.ts. Reading does not consume: only
 * /outbox/ack marks a row delivered.
 */
export async function POST(request: Request) {
  // Throttled before the HMAC check, for the same reason as the webhook route:
  // forging a signature is hopeless, but an unthrottled public endpoint is
  // free CPU for anyone who wants to spend ours. A till polling every 30s uses
  // 2 of these a minute; 120 leaves room for several tills and retries.
  const limit = rateLimit(`pos-fetch:${clientKey(request.headers)}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const secret = process.env.POS_SIGNING_SECRET;
  if (!secret) {
    return Response.json({ error: 'integration not configured' }, { status: 503 });
  }

  try {
    return await handlePosFetch(request, makePullDeps(supabaseService(), secret));
  } catch (err) {
    // Error class only — the rows carry patient identifiers and this goes to a
    // log aggregator.
    console.error('[pos-fetch] unhandled failure', {
      name: err instanceof Error ? err.name : 'unknown',
    });
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
