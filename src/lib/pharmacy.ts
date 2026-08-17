/**
 * Pharmacy — the clinic's read model of the POS pipeline.
 *
 * VITCARE-POS owns dispensing. Nothing in this module changes a medicine's
 * state; the only write the clinic has is withdrawing a prescription, and even
 * that is refused once the patient physically holds the drugs
 * (cancel_prescription, 0019).
 *
 * The distinction this file exists to make visible: a prescription that the
 * pharmacy has not acted on yet looks identical, on a status column alone, to
 * one that never reached the pharmacy because the link is down. Those are
 * completely different problems — the first needs patience, the second needs
 * somebody to fix the integration — so delivery state is carried separately
 * from clinical status and is never folded into it.
 */

export type PrescriptionStatus =
  | 'PENDING' | 'PRICED' | 'DISPENSED' | 'COLLECTED'
  | 'OUT_OF_STOCK' | 'PARTIAL' | 'SUBSTITUTED' | 'CANCELLED';

/** How the outbox is getting on. NONE means no outbox row was ever written —
 *  which is worse than QUEUED, not better: the prescription is not even
 *  waiting in line. */
export type DeliveryState = 'NONE' | 'QUEUED' | 'RETRYING' | 'DELIVERED' | 'FAILED';

export interface PharmacyRow {
  id: string;
  patient_id: string;
  patient_full_name: string;
  patient_mrn: string;
  prescriber_name: string | null;
  status: PrescriptionStatus;
  payer: string;
  total_amount_cents: number | null;
  item_count: number;
  dispensed_item_count: number;
  note: string | null;
  created_at: string;
  updated_at: string;
  delivery_state: DeliveryState;
  delivery_attempts: number | null;
  delivery_next_attempt_at: string | null;
  delivery_last_error: string | null;
}

export const STATUS_LABEL: Record<PrescriptionStatus, string> = {
  PENDING: 'Sent to pharmacy',
  PRICED: 'Priced',
  DISPENSED: 'Dispensed',
  COLLECTED: 'Collected',
  OUT_OF_STOCK: 'Out of stock',
  PARTIAL: 'Partially filled',
  SUBSTITUTED: 'Substituted',
  CANCELLED: 'Cancelled',
};

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  NONE: 'Never queued',
  QUEUED: 'Queued',
  RETRYING: 'Retrying',
  DELIVERED: 'Delivered',
  FAILED: 'Delivery failed',
};

/** The clinical journey is done — the patient has their medicine, or never will. */
export const isClosed = (s: PrescriptionStatus) => s === 'COLLECTED' || s === 'CANCELLED';

/** Mirrors cancel_prescription's guard. */
export const canCancel = (s: PrescriptionStatus) =>
  s !== 'DISPENSED' && s !== 'COLLECTED' && s !== 'CANCELLED';

/**
 * Does this row need a HUMAN to do something, and is that human in the clinic?
 *
 * Deliberately narrow. A PENDING prescription delivered five minutes ago is
 * not a problem and must not be flagged as one — an alert list that fills with
 * normal traffic is one nobody reads. Only two things qualify: the pharmacy
 * cannot fill it (out of stock), or it never got there.
 */
export function needsAttention(r: Pick<PharmacyRow, 'status' | 'delivery_state'>): boolean {
  if (isClosed(r.status)) return false;
  if (r.status === 'OUT_OF_STOCK') return true;
  return r.delivery_state === 'FAILED' || r.delivery_state === 'NONE';
}

/** Minutes a prescription has been waiting, against a caller-supplied clock so
 *  server and client render the same number. */
export function waitingMinutes(r: Pick<PharmacyRow, 'created_at'>, now: number): number {
  return Math.max(0, Math.round((now - new Date(r.created_at).getTime()) / 60000));
}

export interface PharmacyStats {
  open: number;
  awaitingPharmacy: number;
  readyToCollect: number;
  outOfStock: number;
  undelivered: number;
}

export function pharmacyStats(rows: readonly PharmacyRow[]): PharmacyStats {
  const open = rows.filter((r) => !isClosed(r.status));
  return {
    open: open.length,
    awaitingPharmacy: open.filter((r) => r.status === 'PENDING' || r.status === 'PRICED').length,
    readyToCollect: open.filter((r) => r.status === 'DISPENSED').length,
    outOfStock: open.filter((r) => r.status === 'OUT_OF_STOCK').length,
    // Counts what never made it, which is the number that should be zero and
    // is the whole reason delivery state is surfaced at all.
    undelivered: open.filter((r) => r.delivery_state === 'FAILED' || r.delivery_state === 'NONE').length,
  };
}
