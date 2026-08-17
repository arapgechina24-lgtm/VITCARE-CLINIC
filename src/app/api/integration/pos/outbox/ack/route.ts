import { supabaseService } from '@/lib/supabase/server';
import { handlePosAck } from '@/modules/prescriptions/integration/pull-handler';
import { makePullDeps } from '@/lib/integration/pull-deps';
import { rateLimit, clientKey, tooManyRequests } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/integration/pos/outbox/ack
 *
 * The till confirms it has persisted a batch. This is the ONLY thing that
 * marks an outbox row delivered — which is why a forged ack is the dangerous
 * direction here, not a forged fetch: it would retire a prescription that
 * never reached the pharmacy. The HMAC check inside the handler runs before
 * any row is touched, and the suite asserts that.
 */
export async function POST(request: Request) {
  const limit = rateLimit(`pos-ack:${clientKey(request.headers)}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const secret = process.env.POS_SIGNING_SECRET;
  if (!secret) {
    return Response.json({ error: 'integration not configured' }, { status: 503 });
  }

  try {
    return await handlePosAck(request, makePullDeps(supabaseService(), secret));
  } catch (err) {
    console.error('[pos-ack] unhandled failure', {
      name: err instanceof Error ? err.name : 'unknown',
    });
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
