/**
 * VITCARE-CLINIC — Pull endpoints (POS fetches from CLINIC)
 * ---------------------------------------------------------------------------
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The original design had the clinic POST prescriptions to the till. That
 * works when both run on the shared LAN, which is what the till's deployment
 * assumes: its Cloudflare tunnel publishes exactly ONE path to the internet
 * (/api/mpesa/callback) and deploy/cloudflare/check-ingress.sh actively
 * ASSERTS that /api/prescriptions is unreachable from outside the building.
 *
 * With the clinic hosted publicly, that push can never land — not because
 * anything is misconfigured, but because the till deliberately has no inbound
 * public door. Rather than open one on the machine that takes money and issues
 * KRA invoices, the flow is inverted: the till, which already reaches OUT to
 * the internet to deliver status webhooks, also reaches out to collect work.
 * The till's inbound surface stays at zero.
 *
 * ── DELIVERY SEMANTICS ─────────────────────────────────────────────────────
 * At-least-once, with an idempotent consumer. Fetching does NOT mark anything
 * delivered; only an explicit ack does. If the till crashes between the two,
 * the clinic serves the same prescription again and the till discards the
 * duplicate — it already dedupes on prescriptionId, which is what the
 * Idempotency-Key in the push contract was for.
 *
 * The alternative — marking delivered on fetch — turns any crash after the
 * response leaves the clinic into a silently lost prescription. That is the
 * precise failure the outbox was built to prevent, so it is not on the table.
 *
 * A prescription fetched and never acked stays queued and keeps being served.
 * That is visible rather than silent: pharmacy_link_health() reports
 * oldest_undelivered_at, and the pharmacy board shows the row as still queued.
 *
 * ── VERSION NEGOTIATION ────────────────────────────────────────────────────
 * The caller states what it can honour in `X-Contract-Version`, and the clinic
 * serves nothing newer. A till that predates a feature is simply not handed the
 * prescriptions that need it, so a staged rollout is a non-event for the queue
 * of ordinary prescriptions flowing past it.
 *
 * An ABSENT header means a till built before negotiation existed, so it is read
 * as the baseline version rather than as "anything goes". That is the safe
 * direction: the failure of guessing too low is a scheme prescription waiting
 * a little longer, and the failure of guessing too high is a patient charged
 * for medicine their employer has already agreed to pay for.
 *
 * The header sits outside the HMAC. It selects which rows are served and never
 * what they contain, so the worst a forged value can do is narrow the caller's
 * own page — and a caller that wanted fewer rows could simply ask for fewer.
 *
 * ── AUTH ───────────────────────────────────────────────────────────────────
 * Identical to the inbound webhook — HMAC-SHA256 over `${timestamp}.${rawBody}`
 * verified on the raw body inside a five-minute window, via the shared
 * signature module. Both endpoints are POST, including the read: a GET has no
 * body to sign, and inventing a second signing scheme for one verb is how the
 * weaker one becomes the way in.
 */

import { z } from 'zod';
import { rejectIfUnauthentic } from './signature';
import {
  BASELINE_CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  isSupportedVersion,
  type ContractVersion,
} from './prescription-contract';

export interface PendingPrescription {
  /** The outbox row id. This is what the till acks — NOT the prescription id,
   *  because a redelivery is a property of the outbox row. */
  outboxId: string;
  prescriptionId: string;
  /** The CreatePrescription contract body, byte-identical to what the push
   *  path would have sent. The till parses it with the same schema. */
  payload: unknown;
}

export interface PullDeps {
  signingSecret: string;
  /** @param maxVersion the newest contract version the caller can honour;
   *  rows stamped newer than this must not be served. */
  fetchPending(limit: number, maxVersion: ContractVersion): Promise<PendingPrescription[]>;
  markDelivered(outboxId: string): Promise<void>;
  audit(action: string, detail: string): Promise<void>;
}

/** Bounded so one poll cannot ask the clinic to assemble an unbounded page. */
const FetchRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

const AckRequestSchema = z.object({
  outboxIds: z.array(z.string().uuid()).min(1).max(100),
});

/**
 * The newest version this caller says it can honour.
 *
 * Anything unrecognised — absent, malformed, or a version from a FUTURE build
 * this clinic has never heard of — reads as the baseline. A till claiming a
 * version we do not know is a till we cannot reason about, and serving it our
 * newest rows on the strength of a string we cannot interpret is exactly the
 * trust this negotiation exists to withhold.
 */
export function negotiatedVersion(headers: Headers): ContractVersion {
  const declared = headers.get('X-Contract-Version')?.trim();
  return declared && isSupportedVersion(declared) ? declared : BASELINE_CONTRACT_VERSION;
}

/** Every version at or below `max`, oldest first. */
export function versionsUpTo(max: ContractVersion): ContractVersion[] {
  const idx = SUPPORTED_CONTRACT_VERSIONS.indexOf(max);
  return SUPPORTED_CONTRACT_VERSIONS.slice(0, idx + 1) as unknown as ContractVersion[];
}

/**
 * POST /api/integration/pos/outbox/fetch
 * Returns pending prescriptions. Does not change any state.
 */
export async function handlePosFetch(request: Request, deps: PullDeps): Promise<Response> {
  const rawBody = await request.text();

  const rejected = rejectIfUnauthentic(request, rawBody, deps.signingSecret);
  if (rejected) return rejected;

  // Parse only after the signature check, as on the webhook path.
  let limit: number;
  try {
    ({ limit } = FetchRequestSchema.parse(rawBody.trim() === '' ? {} : JSON.parse(rawBody)));
  } catch {
    return Response.json({ error: 'invalid payload' }, { status: 422 });
  }

  const pending = await deps.fetchPending(limit, negotiatedVersion(request.headers));
  return Response.json({ prescriptions: pending, count: pending.length }, { status: 200 });
}

/**
 * POST /api/integration/pos/outbox/ack
 * Marks rows delivered. Idempotent: acking an already-delivered row is a
 * no-op, because a till that retries an ack after a dropped response must not
 * be told it did something wrong.
 */
export async function handlePosAck(request: Request, deps: PullDeps): Promise<Response> {
  const rawBody = await request.text();

  const rejected = rejectIfUnauthentic(request, rawBody, deps.signingSecret);
  if (rejected) return rejected;

  let outboxIds: string[];
  try {
    ({ outboxIds } = AckRequestSchema.parse(JSON.parse(rawBody)));
  } catch {
    return Response.json({ error: 'invalid payload' }, { status: 422 });
  }

  // Sequential rather than Promise.all: a partial failure must leave the rows
  // it already acked marked, so the next poll re-serves only what genuinely did
  // not land. Failing the whole batch would re-serve everything, which is safe
  // but noisy, and hides which row is actually broken.
  let acked = 0;
  for (const id of outboxIds) {
    await deps.markDelivered(id);
    acked += 1;
  }

  await deps.audit('prescription.delivered', `${acked} row(s)`);
  return Response.json({ ok: true, acked }, { status: 200 });
}
