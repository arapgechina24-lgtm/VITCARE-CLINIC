/**
 * VITCARE-CLINIC — POS client + Outbox relay
 * ---------------------------------------------------------------------------
 * WHY the outbox pattern: when a clinician sends a prescription, we do NOT call
 * the POS inline. We write the intent to an `integration_outbox` row in the same
 * DB transaction as the prescription itself, then a background worker relays it.
 * If POS is briefly unreachable the prescription is never lost — the worker
 * retries with backoff. This is the single most important reliability decision
 * on the whole integration.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { CreatePrescriptionSchema, type CreatePrescription, CONTRACT_VERSION } from './prescription-contract';

/** Injected config — never hardcode. Loaded from server-side env only. */
export interface PosClientConfig {
  /** POS base URL, e.g. https://pos.vitcare.internal/api */
  baseUrl: string;
  /** Shared secret for signing requests to POS (HMAC-SHA256). Server-side only. */
  signingSecret: string;
  /** Per-attempt timeout in ms. */
  timeoutMs: number;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Request signing — POS verifies this HMAC to trust the caller.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Compute the request signature. POS recomputes the same over the raw body and
 * timestamp and compares. Timestamp is included to let POS reject replays.
 */
export function signBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/* ─────────────────────────────────────────────────────────────────────────
 * POS client — a single, typed way to push a prescription to the pharmacy.
 * ───────────────────────────────────────────────────────────────────────── */

export interface DeliveryResult {
  ok: boolean;
  /** HTTP status from POS, or 0 on network failure. */
  status: number;
  /** True only for permanent failures (4xx except 408/429) — do not retry. */
  permanent: boolean;
  error?: string;
}

export class PosClient {
  constructor(private readonly config: PosClientConfig) {}

  /**
   * POST a prescription to VITCARE-POS.
   * @param payload validated CreatePrescription
   * @returns whether the delivery succeeded and whether a retry is worthwhile
   */
  async sendPrescription(payload: CreatePrescription): Promise<DeliveryResult> {
    // Validate again at the boundary — defence in depth.
    const parsed = CreatePrescriptionSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, status: 0, permanent: true, error: `Invalid payload: ${parsed.error.message}` };
    }

    const rawBody = JSON.stringify(parsed.data);
    const timestamp = new Date().toISOString();
    const signature = signBody(this.config.signingSecret, timestamp, rawBody);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(`${this.config.baseUrl}/prescriptions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Contract-Version': CONTRACT_VERSION,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
          // POS MUST dedupe on this — safe to retry the same prescription.
          'Idempotency-Key': parsed.data.prescriptionId,
        },
        body: rawBody,
      });

      if (res.ok) return { ok: true, status: res.status, permanent: false };

      // 4xx (except 408/429) = our fault or a rejection — do not retry.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      return { ok: false, status: res.status, permanent, error: `POS responded ${res.status}` };
    } catch (err) {
      // Network/timeout — transient, retry.
      return { ok: false, status: 0, permanent: false, error: err instanceof Error ? err.message : 'network error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Outbox relay worker — drains pending rows and marks delivered/failed.
 * Run on an interval (cron / Supabase Edge Function / a worker loop).
 * ───────────────────────────────────────────────────────────────────────── */

/** Minimal shape the worker needs from an outbox row. */
export interface OutboxRow {
  id: string;
  prescriptionId: string;
  payload: CreatePrescription;
  attempts: number;
}

/** The data operations the worker needs — implement against Supabase. */
export interface OutboxStore {
  /** Claim a batch of undelivered rows whose nextAttemptAt <= now. */
  claimBatch(limit: number): Promise<OutboxRow[]>;
  markDelivered(id: string): Promise<void>;
  /** Schedule a retry with backoff, or mark permanently failed. */
  reschedule(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

const MAX_ATTEMPTS = 8;

/** Exponential backoff with a ceiling: 1m, 2m, 4m … capped at 1h. */
function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
}

/**
 * Process one drain cycle. Call this on a schedule.
 * @returns counts for observability/logging (no PII in logs).
 */
export async function drainOutbox(
  store: OutboxStore,
  pos: PosClient,
  batchSize = 25,
): Promise<{ delivered: number; retried: number; failed: number }> {
  const rows = await store.claimBatch(batchSize);
  let delivered = 0;
  let retried = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await pos.sendPrescription(row.payload);

    if (result.ok) {
      await store.markDelivered(row.id);
      delivered += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    if (result.permanent || attempts >= MAX_ATTEMPTS) {
      await store.markFailed(row.id, result.error ?? 'unknown');
      failed += 1;
      continue;
    }

    await store.reschedule(row.id, attempts, new Date(Date.now() + backoffMs(attempts)));
    retried += 1;
  }

  return { delivered, retried, failed };
}

/* Re-exported for the webhook handler to verify inbound POS signatures. */
export { timingSafeEqual };
