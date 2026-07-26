/**
 * VITCARE-CLINIC — Inbound webhook handler (POS → CLINIC)
 * ---------------------------------------------------------------------------
 * POS calls this endpoint on every prescription status change. Security posture:
 *   1. Verify HMAC signature over the RAW body (never the parsed object).
 *   2. Reject stale timestamps (replay protection).
 *   3. Dedupe on eventId (POS may retry — updates must be idempotent).
 *   4. Enforce the status state machine before persisting.
 *
 * Mounted at POST /api/integration/pos/prescription-status — see
 * src/app/api/integration/pos/prescription-status/route.ts.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PrescriptionStatusEventSchema,
  type PrescriptionStatusEvent,
  type PrescriptionStatus,
  assertTransition,
} from './prescription-contract';

/** Injected dependencies — keeps the handler testable and DB-agnostic. */
export interface WebhookDeps {
  /** Shared secret POS signs with. Server-side env only. */
  signingSecret: string;
  /** True if we've already processed this eventId (idempotency). */
  hasProcessedEvent(eventId: string): Promise<boolean>;
  /** Current status of a prescription, or null if unknown. */
  getPrescriptionStatus(prescriptionId: string): Promise<PrescriptionStatus | null>;
  /** Apply the status change + record the event, in one transaction. */
  applyStatusEvent(event: PrescriptionStatusEvent): Promise<void>;
  /** Write an audit entry (who/what/when). No PII in the audit message. */
  audit(action: string, prescriptionId: string): Promise<void>;
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/** Constant-time signature check. Returns false on any mismatch. */
function verifySignature(secret: string, timestamp: string, rawBody: string, provided: string): boolean {
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/integration/pos/prescription-status
 * @param request the inbound webhook request from POS
 */
export async function handlePosWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const rawBody = await request.text(); // raw string — required for HMAC
  const timestamp = request.headers.get('X-Timestamp');
  const signature = request.headers.get('X-Signature');

  if (!timestamp || !signature) {
    return Response.json({ error: 'missing signature headers' }, { status: 401 });
  }

  // Replay protection.
  const skew = Math.abs(Date.now() - Date.parse(timestamp));
  if (Number.isNaN(skew) || skew > MAX_CLOCK_SKEW_MS) {
    return Response.json({ error: 'stale timestamp' }, { status: 401 });
  }

  if (!verifySignature(deps.signingSecret, timestamp, rawBody, signature)) {
    return Response.json({ error: 'bad signature' }, { status: 401 });
  }

  // Parse + validate only AFTER the signature check.
  let event: PrescriptionStatusEvent;
  try {
    event = PrescriptionStatusEventSchema.parse(JSON.parse(rawBody));
  } catch {
    return Response.json({ error: 'invalid payload' }, { status: 422 });
  }

  // Idempotency: POS may retry the same event. Ack without re-applying.
  if (await deps.hasProcessedEvent(event.eventId)) {
    return Response.json({ ok: true, deduped: true }, { status: 200 });
  }

  // Enforce the state machine.
  const current = await deps.getPrescriptionStatus(event.prescriptionId);
  if (current === null) {
    return Response.json({ error: 'unknown prescription' }, { status: 404 });
  }
  try {
    assertTransition(current, event.status);
  } catch {
    // Return 409 so POS surfaces the conflict rather than retrying forever.
    return Response.json({ error: `illegal transition ${current} → ${event.status}` }, { status: 409 });
  }

  await deps.applyStatusEvent(event);
  await deps.audit(`prescription.${event.status.toLowerCase()}`, event.prescriptionId);

  return Response.json({ ok: true }, { status: 200 });
}
