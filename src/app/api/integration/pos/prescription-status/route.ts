import { supabaseService } from '@/lib/supabase/server';
import { handlePosWebhook } from '@/modules/prescriptions/integration/webhook-handler';
import { makeWebhookDeps } from '@/modules/prescriptions/integration/supabase-deps';

// No requireStaffSession here — POS is not a logged-in staff member. Trust is
// established entirely by the HMAC signature verified inside handlePosWebhook
// (see POS_SIGNING_SECRET below), exactly like vitcare-pos's own M-Pesa
// callback route trusts a shared secret instead of a staff session.
export async function POST(request: Request) {
  const secret = process.env.POS_SIGNING_SECRET;
  if (!secret) {
    return Response.json({ error: 'integration not configured' }, { status: 503 });
  }
  const deps = makeWebhookDeps(supabaseService(), secret);
  return handlePosWebhook(request, deps);
}
