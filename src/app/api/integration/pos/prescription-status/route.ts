import { supabaseService } from '@/lib/supabase/server';
import { handlePosWebhook } from '@/modules/prescriptions/integration/webhook-handler';
import {
  makeWebhookDeps,
  StatusConflictError,
  PrescriptionNotFoundError,
} from '@/modules/prescriptions/integration/supabase-deps';
import { rateLimit, clientKey, tooManyRequests } from '@/lib/rate-limit';

// handlePosWebhook verifies the HMAC with node:crypto, which the edge runtime
// does not provide.
export const runtime = 'nodejs';
/** Never cached — every call mutates clinical state. */
export const dynamic = 'force-dynamic';

// No requireStaffSession here — POS is not a logged-in staff member. Trust is
// established entirely by the HMAC signature verified inside handlePosWebhook
// (see POS_SIGNING_SECRET below), exactly like vitcare-pos's own M-Pesa
// callback route trusts a shared secret instead of a staff session.
export async function POST(request: Request) {
  // Throttled before the HMAC check. Forging a signature is computationally
  // hopeless, but an unthrottled public endpoint is still free CPU for anyone
  // who wants to spend ours. POS drains in batches, so the ceiling is set well
  // above any legitimate burst.
  const limit = rateLimit(`pos-webhook:${clientKey(request.headers)}`, 240, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const secret = process.env.POS_SIGNING_SECRET;
  if (!secret) {
    return Response.json({ error: 'integration not configured' }, { status: 503 });
  }
  const deps = makeWebhookDeps(supabaseService(), secret);

  try {
    return await handlePosWebhook(request, deps);
  } catch (err) {
    // apply_status_event's row-locked re-check beat the handler's pre-flight.
    // Answer with the same codes the pre-flight would have returned, so POS
    // classifies them correctly — a 500 here would have POS retrying a
    // permanently illegal transition until it exhausted its attempt ceiling.
    if (err instanceof StatusConflictError) {
      return Response.json({ error: 'illegal transition' }, { status: 409 });
    }
    if (err instanceof PrescriptionNotFoundError) {
      return Response.json({ error: 'unknown prescription' }, { status: 404 });
    }
    // Genuine fault. Log the error class only — the payload carries patient
    // identifiers and this line goes to a log aggregator.
    console.error('[pos-webhook] unhandled failure', {
      name: err instanceof Error ? err.name : 'unknown',
    });
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
