/**
 * Wires WebhookDeps and OutboxStore (the DB-agnostic interfaces in
 * webhook-handler.ts / pos-client-outbox.ts) against this project's Supabase
 * schema (0001_prescriptions.sql: prescriptions, integration_outbox,
 * processed_webhook_events). Server-only — uses the service-role client,
 * since these tables have no client-role RLS policies at all by design.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebhookDeps } from './webhook-handler';
import type { OutboxStore, OutboxRow } from './pos-client-outbox';
import type { PrescriptionStatus, PrescriptionStatusEvent, CreatePrescription } from './prescription-contract';

/** Error codes raised by apply_status_event (0009). */
export const PG_ILLEGAL_TRANSITION = 'P0001';
export const PG_PRESCRIPTION_NOT_FOUND = 'P0002';

/** The row-locked re-check rejected a transition the handler's pre-flight let
 *  through. Distinct from a generic failure because POS must treat it as
 *  permanent — retrying an illegal transition can never succeed. */
export class StatusConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusConflictError';
  }
}

/** The prescription disappeared between the pre-flight read and the apply. */
export class PrescriptionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrescriptionNotFoundError';
  }
}

export function makeWebhookDeps(supabase: SupabaseClient, signingSecret: string): WebhookDeps {
  return {
    signingSecret,

    async hasProcessedEvent(eventId) {
      const { data } = await supabase.from('processed_webhook_events').select('event_id').eq('event_id', eventId).maybeSingle();
      return !!data;
    },

    async getPrescriptionStatus(prescriptionId) {
      const { data } = await supabase.from('prescriptions').select('status').eq('id', prescriptionId).maybeSingle();
      return (data?.status as PrescriptionStatus | undefined) ?? null;
    },

    async applyStatusEvent(event: PrescriptionStatusEvent) {
      // One call, one transaction, prescription row locked — see
      // 0009_apply_status_event.sql for what this replaced and why. The three
      // defects it fixes were: line items written without checking they belong
      // to this prescription (a cross-patient write), no transaction across the
      // three tables, and a check-then-act race on the status.
      const { error } = await supabase.rpc('apply_status_event', {
        p_event_id: event.eventId,
        p_prescription_id: event.prescriptionId,
        p_status: event.status,
        p_total_amount_cents: event.totalAmountCents ?? null,
        p_reason: event.reason ?? null,
        p_lines: event.lines ?? null,
        // Applied in the SAME transaction as the status change, by the same
        // RPC. A DISPENSED that committed without the farm's charge following
        // would be a medicine handed over for free with nothing left to
        // invoice — and the webhook would never retry, because it succeeded.
        p_scheme_settled: event.schemeSettled ?? null,
      });
      if (!error) return;

      // The row-locked re-check beat the handler's pre-flight. Translate to
      // typed errors so the route answers 409/404 — the same codes the
      // pre-flight would have given — instead of a 500 that POS retries
      // forever against a permanently illegal transition.
      if (error.code === PG_ILLEGAL_TRANSITION) throw new StatusConflictError(error.message);
      if (error.code === PG_PRESCRIPTION_NOT_FOUND) throw new PrescriptionNotFoundError(error.message);
      throw error;
    },

    async audit(action, prescriptionId) {
      // prescriptions/prescription_items writes are already logged by the
      // trg_audit_prescriptions / trg_audit_prescription_items triggers
      // (0001_prescriptions.sql) — this adds the webhook-specific action
      // label (e.g. "prescription.dispensed") the triggers can't know about.
      await supabase.from('audit_log').insert({ action, table_name: 'prescriptions', record_id: prescriptionId });
    },
  };
}

export function makeOutboxStore(supabase: SupabaseClient): OutboxStore {
  return {
    async claimBatch(limit, versions) {
      let query = supabase
        .from('integration_outbox')
        .select('id, prescription_id, payload, attempts')
        .eq('delivered', false)
        .eq('failed', false);
      // Filtered in the QUERY, not over the returned page, and that
      // distinction is the whole point. Filtering afterwards would let a run
      // of scheme prescriptions sitting at the head of the queue fill every
      // page an un-upgraded till asks for, and it would receive an empty list
      // forever while ordinary prescriptions waited behind them. The pharmacy
      // would go quiet with nothing failing anywhere.
      if (versions) query = query.in('payload->>contractVersion', versions);
      const { data, error } = await query
        // 'now' is evaluated by POSTGRES. next_attempt_at is written with the
        // database's clock, so comparing it to this process's clock makes
        // eligibility depend on two machines agreeing — measured skew against
        // this Supabase project was ~0.4s, enough to hide a just-queued row
        // from an immediate drain, and far worse on a host with a drifting
        // clock. One clock decides.
        .lte('next_attempt_at', 'now')
        .order('next_attempt_at', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(
        (r): OutboxRow => ({
          id: r.id as string,
          prescriptionId: r.prescription_id as string,
          payload: r.payload as CreatePrescription,
          attempts: r.attempts as number,
        }),
      );
    },
    async markDelivered(id) {
      const { error } = await supabase.from('integration_outbox').update({ delivered: true }).eq('id', id);
      if (error) throw error;
    },
    async reschedule(id, attempts, nextAttemptAt) {
      const { error } = await supabase
        .from('integration_outbox')
        .update({ attempts, next_attempt_at: nextAttemptAt.toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    async markFailed(id, error) {
      // `failed`, not `delivered` — this prescription never reached the
      // pharmacy and must never be mistaken for one that did. Setting the flag
      // is also what stops the retry loop: without it the row keeps matching
      // the pending query and is re-sent on every single drain, forever.
      const { error: dbError } = await supabase
        .from('integration_outbox')
        .update({ failed: true, last_error: error })
        .eq('id', id);
      if (dbError) throw dbError;
    },
  };
}
