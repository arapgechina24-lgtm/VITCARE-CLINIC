'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, X } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import { formatKes } from '@/lib/billing';
import {
  DELIVERY_LABEL, STATUS_LABEL, canCancel, needsAttention, waitingMinutes,
  type DeliveryState, type PharmacyRow, type PrescriptionStatus,
} from '@/lib/pharmacy';

const STATUS_TONE: Record<PrescriptionStatus, StatusTone> = {
  PENDING: 'warning',
  PRICED: 'warning',
  DISPENSED: 'good',
  COLLECTED: 'good',
  OUT_OF_STOCK: 'critical',
  PARTIAL: 'serious',
  SUBSTITUTED: 'serious',
  CANCELLED: 'neutral',
};

const DELIVERY_TONE: Record<DeliveryState, StatusTone> = {
  NONE: 'critical',
  QUEUED: 'neutral',
  RETRYING: 'warning',
  DELIVERED: 'good',
  FAILED: 'critical',
};

export function PharmacyBoard({
  rows,
  canCancel: mayCancel,
  showDiagnostics,
}: {
  rows: PharmacyRow[];
  canCancel: boolean;
  showDiagnostics: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  // A single clock for the whole render, so every wait is measured against the
  // same instant rather than each row sampling its own slightly-later one.
  const [renderedAt] = useState(() => Date.now());

  async function confirmCancel(id: string) {
    setBusyId(id);
    setError(null);
    const { error } = await supabase.rpc('cancel_prescription', {
      p_prescription_id: id,
      p_reason: reason.trim(),
    });
    setBusyId(null);
    if (error) return setError(error.message);
    setCancelling(null);
    setReason('');
    startTransition(() => router.refresh());
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong py-10 text-center">
        <p className="text-sm text-ink-secondary">No prescriptions are outstanding.</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          Prescriptions appear here the moment a clinician issues one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg bg-critical-wash px-3 py-2">
          <p className="text-xs text-critical-ink">{error}</p>
        </div>
      )}

      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const attention = needsAttention(r);
          const waited = waitingMinutes(r, renderedAt);
          const busy = busyId === r.id || pending;
          return (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-center gap-3">
                {attention && (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-critical" aria-label="Needs attention" />
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{r.patient_full_name}</p>
                  <p className="truncate text-xs text-ink-muted">
                    <span className="tabular">{r.patient_mrn}</span>
                    {r.prescriber_name ? ` · ${r.prescriber_name}` : ''}
                    {` · ${r.item_count} item${r.item_count === 1 ? '' : 's'}`}
                    {r.dispensed_item_count > 0 ? ` (${r.dispensed_item_count} dispensed)` : ''}
                  </p>
                </div>

                {/* POS's figure, labelled as POS's. The clinic never invoices
                    medicines — see the scope note in 0020_billing.sql. */}
                {r.total_amount_cents != null && (
                  <span className="tabular shrink-0 text-xs text-ink-secondary">
                    {formatKes(r.total_amount_cents)}
                    <span className="text-ink-muted"> at till</span>
                  </span>
                )}

                <StatusBadge tone={STATUS_TONE[r.status]} label={STATUS_LABEL[r.status]} />

                {/* Delivery is shown only when it is NOT the happy path, so the
                    normal case stays quiet and a failure stands out. */}
                {r.delivery_state !== 'DELIVERED' && (
                  <StatusBadge
                    tone={DELIVERY_TONE[r.delivery_state]}
                    label={DELIVERY_LABEL[r.delivery_state]}
                  />
                )}

                <span className="tabular w-14 shrink-0 text-right text-2xs text-ink-muted">
                  {waited < 60 ? `${waited}m` : `${Math.floor(waited / 60)}h`}
                </span>

                {mayCancel && canCancel(r.status) && (
                  <button
                    type="button"
                    onClick={() => { setCancelling(cancelling === r.id ? null : r.id); setReason(''); }}
                    disabled={busy}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-2xs text-ink-secondary transition-colors hover:bg-surface-hover disabled:opacity-40"
                  >
                    <X className="h-3 w-3" aria-hidden />
                    Withdraw
                  </button>
                )}
              </div>

              {showDiagnostics && r.delivery_last_error && (
                <p className="mt-1 truncate text-2xs text-ink-muted" title={r.delivery_last_error}>
                  Last delivery error: {r.delivery_last_error}
                </p>
              )}

              {cancelling === r.id && (
                <div className="mt-2 rounded-lg border border-line bg-surface-sunken p-3">
                  <label htmlFor={`why-${r.id}`} className="mb-1 block text-xs font-medium text-ink-secondary">
                    Why is this prescription being withdrawn?
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <input
                      id={`why-${r.id}`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Changed after review of allergy history"
                      className="min-w-[220px] flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
                    />
                    <button
                      type="button"
                      onClick={() => confirmCancel(r.id)}
                      disabled={busy || reason.trim().length === 0}
                      className="rounded-lg bg-critical px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                    >
                      {busy ? 'Withdrawing…' : 'Withdraw prescription'}
                    </button>
                  </div>
                  <p className="mt-1.5 text-2xs text-ink-muted">
                    The reason is appended to the prescription and recorded in the audit log.
                    The pharmacy is told through the normal status contract.
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
