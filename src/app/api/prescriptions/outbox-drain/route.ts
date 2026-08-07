import { NextResponse, type NextRequest } from 'next/server';
import { supabaseService } from '@/lib/supabase/server';
import { PosClient, drainOutbox } from '@/modules/prescriptions/integration/pos-client-outbox';
import { makeOutboxStore } from '@/modules/prescriptions/integration/supabase-deps';
import { authorizeDrain } from '@/modules/prescriptions/integration/drain-auth';
import { rateLimit, clientKey, tooManyRequests } from '@/lib/rate-limit';

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
  // Rate limit BEFORE the secret check, so a brute-force attempt is throttled
  // rather than merely rejected. A legitimate scheduler runs twice a minute;
  // 30 leaves generous headroom for a manual re-run during an incident.
  const limit = rateLimit(`outbox-drain:${clientKey(req.headers)}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  // Authorization header, not a query string — query strings are written to
  // access logs, proxy logs and browser history, and this secret drives the
  // whole integration. Constant-time comparison; see integration/drain-auth.ts.
  //
  //   curl -X POST http://localhost:3001/api/prescriptions/outbox-drain \
  //     -H "Authorization: Bearer $OUTBOX_DRAIN_SECRET"
  if (!authorizeDrain(req.headers, process.env.OUTBOX_DRAIN_SECRET)) {
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
