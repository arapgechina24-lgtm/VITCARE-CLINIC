/**
 * Wires PullDeps against this project's Supabase tables.
 *
 * Sibling of makeWebhookDeps / makeOutboxStore in
 * modules/prescriptions/integration/supabase-deps.ts, and deliberately reuses
 * makeOutboxStore rather than re-querying integration_outbox: eligibility
 * (delivered = false, failed = false, next_attempt_at <= the DATABASE's clock)
 * is subtle enough that a second copy would drift, and the push path and the
 * pull path must agree on what is eligible for delivery at all.
 *
 * They no longer serve an identical SET: the pull path additionally withholds
 * rows stamped newer than the calling till can honour. That is a narrowing of
 * the same eligibility rule by something only the caller knows, not a second
 * opinion about it — which is why it is a parameter here rather than a second
 * query.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeOutboxStore } from '@/modules/prescriptions/integration/supabase-deps';
import { versionsUpTo, type PullDeps } from '@/modules/prescriptions/integration/pull-handler';

export function makePullDeps(supabase: SupabaseClient, signingSecret: string): PullDeps {
  const store = makeOutboxStore(supabase);
  return {
    signingSecret,
    async fetchPending(limit, maxVersion) {
      const rows = await store.claimBatch(limit, versionsUpTo(maxVersion));
      return rows.map((r) => ({
        outboxId: r.id,
        prescriptionId: r.prescriptionId,
        payload: r.payload,
      }));
    },
    markDelivered: (id) => store.markDelivered(id),
    async audit(action, detail) {
      // No patient identifiers: this row is written on every poll and the
      // audit log is read by people reviewing access to records, not delivery
      // plumbing. The count is the useful part.
      const { error } = await supabase.from('audit_log').insert({
        action: 'UPDATE',
        table_name: 'integration_outbox',
        details: { fn: action, detail },
      });
      if (error) throw error;
    },
  };
}
