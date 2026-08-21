/**
 * Billing — money formatting and the parts that are arithmetic.
 *
 * The database owns the totals (0020_billing.sql recomputes subtotal, VAT,
 * total and paid by trigger on every write). Nothing here recalculates them;
 * a second implementation of "what does this invoice come to" is exactly how a
 * screen ends up disagreeing with the document a patient is holding. What this
 * file does is FORMAT what the server already decided, and derive the small
 * presentational facts — outstanding, whether an action is available — from it.
 */

import type { Payer, PriceBasis } from './catalogue';

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PART_PAID' | 'PAID' | 'VOID';
export type PaymentMethod = 'CASH' | 'MPESA' | 'INSURER' | 'WAIVER';

export interface InvoiceSummary {
  id: string;
  invoice_no: string | null;
  patient_id: string;
  patient_full_name: string;
  patient_mrn: string;
  encounter_id: string | null;
  status: InvoiceStatus;
  payer: Payer;
  total_cents: number;
  paid_cents: number;
  issued_at: string | null;
  created_at: string;
}

export interface InvoiceItemRow {
  id: string;
  description: string;
  /** Snapshotted with the price: "Dental extraction x3" is ambiguous in a way
   *  "x3 teeth" is not, and the catalogue can be re-worded later. */
  unit: string | null;
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
  /** Which column the price came from, so a zero can be explained rather than
   *  merely displayed. See 0023's note on the column. */
  price_basis: PriceBasis;
}

export interface PaymentRow {
  id: string;
  method: PaymentMethod;
  amount_cents: number;
  reference: string | null;
  received_at: string;
  received_by_name: string | null;
}

/**
 * Cents → "KSh 1,234.56".
 *
 * Integer arithmetic only: (cents / 100).toFixed(2) goes through a float, and
 * 1_000_005 / 100 is 10000.049999999999, which renders as 10000.05 by luck
 * rather than by rule. Splitting the integer keeps every figure exact.
 */
export function formatKes(cents: number, opts: { symbol?: boolean } = {}): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  const grouped = whole.toLocaleString('en-KE');
  const body = `${grouped}.${String(frac).padStart(2, '0')}`;
  const sign = negative ? '-' : '';
  return opts.symbol === false ? `${sign}${body}` : `${sign}KSh ${body}`;
}

/** Shillings entered by a human → cents. Returns null for anything that is not
 *  a clean, non-negative money amount, so a typo cannot become a payment. */
export function parseKesToCents(input: string): number | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export const outstandingCents = (i: Pick<InvoiceSummary, 'total_cents' | 'paid_cents'>) =>
  Math.max(0, i.total_cents - i.paid_cents);

export const isOpen = (s: InvoiceStatus) => s === 'ISSUED' || s === 'PART_PAID';

/** Mirrors add_invoice_item / remove_invoice_item: draft only. */
export const canEditCharges = (s: InvoiceStatus) => s === 'DRAFT';
/** Mirrors issue_invoice. */
export const canIssue = (s: InvoiceStatus, itemCount: number) => s === 'DRAFT' && itemCount > 0;
/** Mirrors record_payment: not a draft, not void, and something still owed. */
export const canTakePayment = (i: Pick<InvoiceSummary, 'status' | 'total_cents' | 'paid_cents'>) =>
  isOpen(i.status) && outstandingCents(i) > 0;
/** Mirrors void_invoice: ADMIN-only is enforced separately; nothing paid. */
export const canVoid = (i: Pick<InvoiceSummary, 'status' | 'paid_cents'>) =>
  i.status !== 'VOID' && i.paid_cents === 0;

export type { Payer };

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Unpaid',
  PART_PAID: 'Part paid',
  PAID: 'Paid',
  VOID: 'Void',
};

/** Line total EXCLUDING VAT — the figure the server stores as the line's
 *  contribution to subtotal. Presentational only; see the note at the top. */
export const lineSubtotalCents = (it: Pick<InvoiceItemRow, 'quantity' | 'unit_price_cents'>) =>
  it.quantity * it.unit_price_cents;

/** VAT for one line, rounded the same way 0020's trigger rounds it: per line,
 *  half-up. If this ever disagrees with the server the displayed lines will not
 *  add up to the displayed total, which is why it is written to match rather
 *  than to be independently "correct". */
export const lineVatCents = (it: Pick<InvoiceItemRow, 'quantity' | 'unit_price_cents' | 'vat_rate'>) =>
  Math.round(lineSubtotalCents(it) * it.vat_rate);
