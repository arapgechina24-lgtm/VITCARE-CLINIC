import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import type { RecordPrescription } from '@/lib/patient-record';

/**
 * Prescriptions, with the live dispensing status reported back by the pharmacy
 * over the integration contract — this is the clinician-facing end of that
 * loop, so a doctor can see whether the patient actually got their medicine.
 */

const STATUS: Record<string, { tone: StatusTone; label: string }> = {
  PENDING: { tone: 'warning', label: 'Sent to pharmacy' },
  PRICED: { tone: 'warning', label: 'Priced, awaiting collection' },
  DISPENSED: { tone: 'good', label: 'Dispensed' },
  COLLECTED: { tone: 'good', label: 'Collected' },
  PARTIAL: { tone: 'serious', label: 'Partially dispensed' },
  SUBSTITUTED: { tone: 'serious', label: 'Substituted' },
  OUT_OF_STOCK: { tone: 'critical', label: 'Out of stock' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
  DRAFT: { tone: 'neutral', label: 'Draft' },
};

const KES = (cents: number) =>
  `KSh ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function PrescriptionsPanel({ prescriptions }: { prescriptions: RecordPrescription[] }) {
  if (prescriptions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-muted">
        No prescriptions issued to this patient yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {prescriptions.map((p) => {
        const s = STATUS[p.status] ?? { tone: 'neutral' as StatusTone, label: p.status };
        return (
          <div key={p.id} className="rounded-xl border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {new Date(p.created_at).toLocaleDateString('en-KE', { dateStyle: 'medium' })}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {p.prescriber ? `${p.prescriber} · ` : ''}
                  {p.payer}
                  {p.total_amount_cents != null ? ` · ${KES(p.total_amount_cents)}` : ''}
                </p>
              </div>
              <StatusBadge tone={s.tone} label={s.label} />
            </div>

            <ul className="divide-y divide-line">
              {p.items.map((item) => {
                // A line the pharmacy could not fully fill is the thing a
                // clinician most needs to notice, so it is called out rather
                // than left to be inferred from a quantity mismatch.
                const shortfall =
                  item.dispensed_quantity != null && item.dispensed_quantity < item.quantity;
                return (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="text-sm font-medium text-ink">
                        {item.drug_name}
                        {item.strength ? ` ${item.strength}` : ''}
                      </p>
                      <p className="tabular text-xs text-ink-muted">
                        {item.dispensed_quantity != null
                          ? `${item.dispensed_quantity} of ${item.quantity} dispensed`
                          : `Qty ${item.quantity}`}
                      </p>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-secondary">
                      {item.dose} · {item.frequency}
                      {item.duration_days ? ` · ${item.duration_days} days` : ''}
                      {item.substitution_allowed ? ' · generic permitted' : ''}
                    </p>
                    {item.instructions && (
                      <p className="mt-0.5 text-xs italic text-ink-muted">{item.instructions}</p>
                    )}
                    {shortfall && (
                      <p className="mt-1.5">
                        <StatusBadge tone="serious" label="Not fully dispensed" />
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            {p.note && (
              <p className="border-t border-line px-4 py-2.5 text-xs text-ink-muted">
                Note to pharmacist: {p.note}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
