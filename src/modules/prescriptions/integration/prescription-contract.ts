/**
 * VITCARE-CLINIC ↔ VITCARE-POS — Prescription Integration Contract
 * ---------------------------------------------------------------------------
 * This file is the SINGLE SOURCE OF TRUTH shared (by copy) between the clinic
 * and the pharmacy POS. Neither system imports the other's code — they agree on
 * the schemas and status vocabulary defined here.
 *
 * WHY a versioned contract: the two systems ship independently. A rename or a
 * new field must not silently break the other side. Any breaking change bumps
 * CONTRACT_VERSION and both sides negotiate on the `X-Contract-Version` header.
 *
 * COPY THIS FILE VERBATIM into vitcare-pos (e.g. src/lib/integration/prescription-contract.ts)
 * when wiring the POS side of Phase 1 — see the README in this directory.
 */

import { z } from 'zod';

/** Bump on any breaking change to the schemas or status vocabulary below. */
export const CONTRACT_VERSION = '1.0.0' as const;

/* ─────────────────────────────────────────────────────────────────────────
 * Status vocabulary — the shared language between CLINIC and POS.
 * Never rename a status without a CONTRACT_VERSION bump.
 * ───────────────────────────────────────────────────────────────────────── */

export const PrescriptionStatus = {
  /** Clinic-only. Not yet transmitted to POS. */
  DRAFT: 'DRAFT',
  /** Sent to POS, awaiting stock check + pricing. */
  PENDING: 'PENDING',
  /** POS has confirmed stock and priced the items; patient can collect. */
  PRICED: 'PRICED',
  /** Pharmacist dispensed and payment was taken at POS. */
  DISPENSED: 'DISPENSED',
  /** Patient physically received the drugs. Terminal (success). */
  COLLECTED: 'COLLECTED',
  /** One or more items unavailable. Clinician must review. */
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  /** Only some items dispensed. */
  PARTIAL: 'PARTIAL',
  /** A drug was swapped (e.g. generic). Requires clinician awareness. */
  SUBSTITUTED: 'SUBSTITUTED',
  /** Cancelled by clinician or pharmacist. Terminal. */
  CANCELLED: 'CANCELLED',
} as const;

export type PrescriptionStatus = (typeof PrescriptionStatus)[keyof typeof PrescriptionStatus];

/**
 * Allowed status transitions. Enforced by `assertTransition` so no code path can
 * move a prescription into an impossible state (e.g. COLLECTED → PENDING).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<PrescriptionStatus, readonly PrescriptionStatus[]>> = {
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['PRICED', 'OUT_OF_STOCK', 'CANCELLED'],
  PRICED: ['DISPENSED', 'PARTIAL', 'SUBSTITUTED', 'OUT_OF_STOCK', 'CANCELLED'],
  OUT_OF_STOCK: ['PRICED', 'CANCELLED'],
  SUBSTITUTED: ['DISPENSED', 'PARTIAL', 'CANCELLED'],
  PARTIAL: ['DISPENSED', 'COLLECTED', 'CANCELLED'],
  DISPENSED: ['COLLECTED'],
  COLLECTED: [],
  CANCELLED: [],
};

/**
 * Throws if `next` is not a legal transition from `current`.
 * @param current the prescription's present status
 * @param next    the proposed new status
 */
export function assertTransition(current: PrescriptionStatus, next: PrescriptionStatus): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`Illegal prescription transition: ${current} → ${next}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Payload schemas (Zod = runtime validation + inferred TS types).
 * Validate at EVERY boundary. Never trust a payload because it "should" be right.
 * ───────────────────────────────────────────────────────────────────────── */

/** A single drug line on a prescription. */
export const PrescriptionItemSchema = z.object({
  /** Stable clinic-side line id (idempotency + reconciliation). */
  itemId: z.string().uuid(),
  /** POS drug catalogue code if known; POS resolves final SKU. */
  drugCode: z.string().min(1).optional(),
  drugName: z.string().min(1),
  /** e.g. "500mg". Free text — clinical, not for pricing. */
  strength: z.string().min(1).optional(),
  dose: z.string().min(1), // e.g. "1 tablet"
  frequency: z.string().min(1), // e.g. "TDS", "BD", "OD"
  durationDays: z.number().int().positive().optional(),
  quantity: z.number().int().positive(),
  instructions: z.string().max(500).optional(),
  /** Clinician allows a generic/therapeutic substitution for this line. */
  substitutionAllowed: z.boolean().default(false),
});
export type PrescriptionItem = z.infer<typeof PrescriptionItemSchema>;

/** CLINIC → POS. Create a prescription in the pharmacy queue. */
export const CreatePrescriptionSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  /** Clinic-side prescription id. Also the idempotency key for POS. */
  prescriptionId: z.string().uuid(),
  /** Which pharmacy/site should fulfil this. */
  fulfillmentSiteId: z.string().uuid(),
  patient: z.object({
    mrn: z.string().min(1),
    fullName: z.string().min(1),
    phone: z.string().min(1).optional(),
    /** Payer at point of dispensing: cash, SHA, or a private insurer code. */
    payer: z.enum(['CASH', 'SHA', 'INSURER']).default('CASH'),
    insurerCode: z.string().min(1).optional(),
  }),
  prescriber: z.object({
    userId: z.string().uuid(),
    name: z.string().min(1),
    /** Practitioner licence/registration no. — needed for regulated dispensing. */
    licenseNo: z.string().min(1).optional(),
  }),
  encounterId: z.string().uuid(),
  items: z.array(PrescriptionItemSchema).min(1),
  issuedAt: z.string().datetime(), // ISO 8601
  note: z.string().max(1000).optional(),
});
export type CreatePrescription = z.infer<typeof CreatePrescriptionSchema>;

/** POS → CLINIC. Sent on every status change via webhook. */
export const PrescriptionStatusEventSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  /** Unique per event — the CLINIC uses this to dedupe webhook retries. */
  eventId: z.string().uuid(),
  prescriptionId: z.string().uuid(),
  status: z.enum([
    PrescriptionStatus.PRICED,
    PrescriptionStatus.DISPENSED,
    PrescriptionStatus.COLLECTED,
    PrescriptionStatus.OUT_OF_STOCK,
    PrescriptionStatus.PARTIAL,
    PrescriptionStatus.SUBSTITUTED,
    PrescriptionStatus.CANCELLED,
  ]),
  occurredAt: z.string().datetime(),
  /** Present on PRICED/DISPENSED — total the patient pays/paid, in KES cents. */
  totalAmountCents: z.number().int().nonnegative().optional(),
  /** Per-line outcome — lets the clinician see exactly what happened. */
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        dispensedQuantity: z.number().int().nonnegative(),
        substitutedWith: z.string().min(1).optional(),
        lineStatus: z.enum(['OK', 'SUBSTITUTED', 'OUT_OF_STOCK', 'PARTIAL']),
      }),
    )
    .optional(),
  reason: z.string().max(500).optional(),
});
export type PrescriptionStatusEvent = z.infer<typeof PrescriptionStatusEventSchema>;
