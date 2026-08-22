/**
 * The service catalogue, and the one rule that decides what a service costs.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM billing.ts ────────────────────────
 * billing.ts formats money the server has already decided. This file answers a
 * question the server has NOT yet been asked: what would this service cost this
 * patient, and may it be charged at all? A screen needs that before the click,
 * to price a picker and to grey out what would be refused.
 *
 * Which makes it a mirror of server logic, and mirrors drift. The rule below is
 * a transcription of billing_price_cents / billing_price_basis in
 * 0025_payer_aware_pricing.sql, and chargeBlockReason is a transcription of the
 * three refusals in add_invoice_item. If they ever disagree, THE SERVER IS
 * RIGHT — it is the one holding the transaction. What this file buys is that a
 * receptionist sees "KEPI immunisation — never charged" on the list instead of
 * discovering it from an error after selecting it.
 *
 * The costly half of the mirror is already avoided: list_service_catalog
 * returns price_cents, price_basis and chargeable computed BY THE SERVER for
 * the payer it was asked about, so the normal path renders server numbers. The
 * functions here are for the cases a fresh round-trip cannot cover — chiefly
 * showing what the other payer would pay before the payer is switched.
 */

/** Who settles the bill. Set when the invoice is opened, never at issue. */
export type Payer = 'CASH' | 'SHA' | 'INSURER';

/** Which column a line was priced from. Recorded on every invoice line so a
 *  zero is explainable rather than merely present. */
export type PriceBasis = 'CASH' | 'INSURANCE' | 'SHA_COVERED';

/** SHA Primary Healthcare Fund coverage, as the catalogue states it. */
export type ShaStatus = 'Covered' | 'Partial' | 'Not covered' | 'Free';

export interface CatalogueService {
  id: string;
  code: string;
  name: string;
  category: string | null;
  sub_category: string | null;
  unit: string | null;
  module: string;
  sha_phc_status: ShaStatus;
  billable: boolean;
  active: boolean;
  cash_price_cents: number;
  insurance_price_cents: number;
  /** Priced by the server for the payer it was asked about. */
  price_cents: number;
  price_basis: PriceBasis;
  effective_from: string;
  /** The server's own answer to "would add_invoice_item accept this?" */
  chargeable: boolean;
  billing_notes: string | null;
}

/**
 * Mirrors billing_price_cents.
 *
 *   CASH     → cash
 *   INSURER  → the credit tariff (cash + 20%, rounded to KES 50)
 *   SHA      → 0 where SHA covers it, otherwise cash
 *
 * SHA-covered is zero rather than refused because the Primary Healthcare Fund
 * pays by capitation on REPORTED VOLUME: the patient must not be charged, and
 * the service must still appear on the record. Zero satisfies both.
 */
export function priceForPayer(
  payer: Payer,
  sha: ShaStatus,
  cashCents: number,
  insuranceCents: number,
): number {
  if (payer === 'INSURER') return insuranceCents;
  if (payer === 'SHA' && sha === 'Covered') return 0;
  return cashCents;
}

/** Mirrors billing_price_basis. */
export function priceBasisFor(payer: Payer, sha: ShaStatus): PriceBasis {
  if (payer === 'INSURER') return 'INSURANCE';
  if (payer === 'SHA' && sha === 'Covered') return 'SHA_COVERED';
  return 'CASH';
}

/**
 * Mirrors the three refusals in add_invoice_item, in the same order, and
 * returns the reason rather than a boolean — the desk has a patient in front of
 * it and needs something to say.
 *
 * `today` is a clinic-local YYYY-MM-DD (see clinicDateKey); string comparison
 * is exact on that format and avoids re-deriving a date in the browser's zone,
 * which at 01:00 in Nairobi is still yesterday.
 */
export function chargeBlockReason(
  svc: Pick<CatalogueService,
    'code' | 'billable' | 'active' | 'module' | 'effective_from' | 'billing_notes'>,
  today: string,
): string | null {
  if (!svc.billable) {
    return svc.billing_notes ?? 'Statutory or programme-funded — must not be charged.';
  }
  if (!svc.active) {
    return `Not available here — the ${moduleLabel(svc.module)} module is not active.`;
  }
  if (svc.effective_from > today) {
    return `Priced from ${svc.effective_from} — not chargeable yet.`;
  }
  return null;
}

/** 'Conditional - Imaging' → 'Imaging'; 'Core' → 'Core'. */
export function moduleLabel(module: string): string {
  return module.startsWith('Conditional - ') ? module.slice('Conditional - '.length) : module;
}

export const isConditional = (module: string) => module.startsWith('Conditional - ');

export const PAYER_LABEL: Record<Payer, string> = {
  CASH: 'Cash / self-paying',
  SHA: 'SHA',
  INSURER: 'Insurer / scheme',
};

/** Shown against a line so a zero is never mistaken for a typo. */
export const PRICE_BASIS_LABEL: Record<PriceBasis, string> = {
  CASH: 'Cash rate',
  INSURANCE: 'Credit tariff',
  SHA_COVERED: 'SHA covers this',
};

/**
 * Free-text search over the catalogue. 237 services is too many for a dropdown
 * and too few to justify a server round-trip per keystroke.
 *
 * Every term must match somewhere — typing "urine culture" should find
 * "Urine microscopy, culture & sensitivity" even though the words are not
 * adjacent, while still narrowing rather than widening as you type.
 */
export function searchServices<T extends Pick<CatalogueService,
  'code' | 'name' | 'category' | 'sub_category'>>(rows: T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((r) => {
    const hay = `${r.code} ${r.name} ${r.category ?? ''} ${r.sub_category ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** Category → services, preserving the server's ordering within each group. */
export function groupByCategory<T extends Pick<CatalogueService, 'category'>>(
  rows: T[],
): Array<[string, T[]]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.category ?? 'Other';
    const bucket = out.get(key);
    if (bucket) bucket.push(r);
    else out.set(key, [r]);
  }
  return [...out];
}
