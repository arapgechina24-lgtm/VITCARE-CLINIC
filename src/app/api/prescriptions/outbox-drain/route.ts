import { NextResponse, type NextRequest } from 'next/server';
import { supabaseService } from '@/lib/supabase/server';
import { PosClient, drainOutbox } from '@/modules/prescriptions/integration/pos-client-outbox';
import { makeOutboxStore } from '@/modules/prescriptions/integration/supabase-deps';

/**
 * Drains integration_outbox — call this on a schedule (every 30s per the
 * design doc). Not a staff-facing endpoint, so it's gated by a shared secret
 * query token (OUTBOX_DRAIN_SECRET) rather than requireStaffSession, the same
 * pattern vitcare-pos uses for its M-Pesa callback. Wire the schedule with
 * whatever the deploy target supports: a Vercel Cron Job, a Supabase Edge
 * Function on pg_cron, or (for the single-clinic LAN deploy) a launchd/
 * Task Scheduler timer hitting this URL — see the till's own
 * scripts/setup-windows-task.ps1 / com.vitcare.pos.plist for that pattern.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.OUTBOX_DRAIN_SECRET;
  if (!secret || req.nextUrl.searchParams.get('token') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const baseUrl = process.env.POS_BASE_URL;
  const signingSecret = process.env.POS_SIGNING_SECRET;
  if (!baseUrl || !signingSecret) {
    return NextResponse.json({ error: 'integration not configured' }, { status: 503 });
  }

  const store = makeOutboxStore(supabaseService());
  const pos = new PosClient({ baseUrl, signingSecret, timeoutMs: Number(process.env.POS_REQUEST_TIMEOUT_MS ?? 8000) });
  const result = await drainOutbox(store, pos);
  return NextResponse.json(result);
}
