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
      const update: Record<string, unknown> = { status: event.status, updated_at: new Date().toISOString() };
      if (event.totalAmountCents !== undefined) update.total_amount_cents = event.totalAmountCents;

      const { error: updateError } = await supabase.from('prescriptions').update(update).eq('id', event.prescriptionId);
      if (updateError) throw updateError;

      if (event.lines?.length) {
        for (const line of event.lines) {
          const { error } = await supabase
            .from('prescription_items')
            .update({ dispensed_quantity: line.dispensedQuantity, line_status: line.lineStatus })
            .eq('id', line.itemId);
          if (error) throw error;
        }
      }

      const { error: insertError } = await supabase
        .from('processed_webhook_events')
        .insert({ event_id: event.eventId, prescription_id: event.prescriptionId, status: event.status });
      if (insertError) throw insertError;
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
    async claimBatch(limit) {
      const { data, error } = await supabase
        .from('integration_outbox')
        .select('id, prescription_id, payload, attempts')
        .eq('delivered', false)
        .eq('failed', false)
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
