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

/**
 * The version a SENDER stamps when it needs the newest features. Bump on any
 * breaking change to the schemas or status vocabulary below.
 *
 * A sender does NOT stamp this on everything. See `versionFor` — an ordinary
 * prescription still goes out as 1.0.0 so that a till which predates this
 * version keeps dispensing normally through a staged rollout.
 */
export const CONTRACT_VERSION = '1.1.0' as const;

/** The version every field in 1.0.0 belongs to. Never changes. */
export const BASELINE_CONTRACT_VERSION = '1.0.0' as const;

/**
 * What a RECEIVER accepts. Older than the newest is fine — a 1.0.0 payload
 * means the other side has not been upgraded yet, not that it is wrong.
 *
 * WHY a set rather than `z.literal(CONTRACT_VERSION)`, which is what this was:
 * a literal makes every version bump a synchronised cutover of clinic and
 * till at the same minute, which this facility cannot do — the tills are on a
 * LAN in a pharmacy that is open. A receiver that accepts a range can be
 * deployed first, and the sender starts using the new version afterwards.
 *
 * Ordered oldest to newest.
 */
export const SUPPORTED_CONTRACT_VERSIONS = ['1.0.0', '1.1.0'] as const;

export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];

/** True when `v` is a version this build understands. */
export function isSupportedVersion(v: string): v is ContractVersion {
  return (SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(v);
}

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

/**
 * CLINIC → POS. "This dispensing is settled by a corporate scheme — hand the
 * medicine over and do NOT collect from the patient."
 *
 * ── WHY THIS IS NOT A FOURTH `payer` VALUE ────────────────────────────────
 * The obvious shape is `payer: 'SCHEME'`. It is wrong for the same two reasons
 * that kept `SCHEME` out of the clinic's own payer enum, and one more that is
 * specific to this direction of the wire:
 *
 *  1. `payer` is written into `invoices`, into `prescriptions`, and validated
 *     by a Zod enum on BOTH sides of this contract. A till that predates the
 *     value rejects the whole payload — so every scheme prescription would
 *     fail as a schema error rather than as a considered refusal.
 *  2. `payer` answers "who is billed for the consultation". Settlement answers
 *     "does the cashier open the drawer". A visit can be billed to a farm and
 *     still have the patient pay cash for a medicine the contract excludes.
 *  3. Payer is a property of the PATIENT on this payload. Settlement is a
 *     property of THIS PRESCRIPTION. Hanging it off `patient` would imply the
 *     next prescription for the same person inherits it. It does not.
 *
 * ── WHY IT CARRIES NO PRICE ───────────────────────────────────────────────
 * Deliberately absent. Drug prices live in the POS catalogue and nowhere else
 * — `PHA-005` in the clinic's service catalogue is marked non-billable with
 * the note "PRICED IN VITCARE-POS - not in this catalogue. Do not
 * double-maintain." A price here would be a second copy of the shelf's prices,
 * maintained by whoever last edited a tariff row, and the two would drift.
 *
 * So the flow is: the clinic says WHO settles, the till says HOW MUCH, and the
 * clinic posts that figure onto the farm's statement. The value travels back on
 * the status event as `schemeSettled.amountCents`, never forward on this one.
 */
export const SchemeSettlementSchema = z.object({
  /**
   * The membership that settles this, NOT the scheme charge it will land on.
   *
   * The charge does not exist yet. A clinician prescribes during the visit and
   * posts the visit to the scheme at the end of it, so at the moment this
   * payload is built there is frequently nothing to point at. Naming the charge
   * here would either force the desk to post the visit before the patient could
   * be given a prescription, or ship an id that is null exactly when the
   * workflow is normal.
   *
   * The membership is stable, known at prescribing time, and enough: the clinic
   * resolves the dispensing back to a charge through the prescription's own
   * encounter when the till reports what it handed over.
   */
  memberId: z.string().uuid(),
  /** Short code, e.g. "SRK". For the till's own display and audit line. */
  schemeCode: z.string().min(1),
  /** Farm/company name, shown to the cashier so they can see who is paying. */
  schemeName: z.string().min(1),
  /**
   * The farm's identifier for this patient — what its finance office
   * reconciles against. The employee's number where the farm issues no
   * individual card, since a dependant is billed under the employee.
   */
  memberNo: z.string().min(1),
});
export type SchemeSettlement = z.infer<typeof SchemeSettlementSchema>;

/** CLINIC → POS. Create a prescription in the pharmacy queue. */
export const CreatePrescriptionSchema = z.object({
  contractVersion: z.enum(SUPPORTED_CONTRACT_VERSIONS),
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
  /** Present only when a corporate scheme settles this dispensing. Absent on
   *  an ordinary prescription, which is the overwhelming majority. */
  settlement: SchemeSettlementSchema.optional(),
}).superRefine((v, ctx) => {
  // ── The safety interlock of this whole feature ──────────────────────────
  // A settlement instruction that a receiver silently ignores is the worst
  // outcome available: the farm is billed on its monthly statement AND the
  // patient is charged at the window for the same medicine. One dispensing,
  // two bills, and nothing looks wrong on either document.
  //
  // Stamping the payload 1.1.0 is what stops that. A till built before this
  // feature validates `contractVersion` with `z.literal('1.0.0')`, so a 1.1.0
  // payload fails its schema outright — it is rejected, NOT acked, and stays
  // in the clinic's outbox where it is visible. Nothing is dispensed and
  // nothing is collected, which is the correct answer for a till that cannot
  // honour the instruction.
  //
  // Tying the two together here, rather than trusting each sender to
  // remember, means the mistake cannot be made: a settlement stamped 1.0.0 is
  // refused by the sender's own validation before it reaches the wire.
  if (v.settlement && v.contractVersion === BASELINE_CONTRACT_VERSION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contractVersion'],
      message:
        `a prescription settled by a scheme must be stamped ${CONTRACT_VERSION}: ` +
        `${BASELINE_CONTRACT_VERSION} receivers ignore the settlement block and would collect from the patient`,
    });
  }
});
export type CreatePrescription = z.infer<typeof CreatePrescriptionSchema>;

/**
 * The version a prescription must be stamped with, given what it carries.
 *
 * Keeps ordinary prescriptions on 1.0.0 during a staged rollout so that only
 * the payloads which genuinely need the new semantics are withheld from a till
 * that has not been upgraded.
 */
export function versionFor(input: { settlement?: unknown }): ContractVersion {
  return input.settlement ? CONTRACT_VERSION : BASELINE_CONTRACT_VERSION;
}

/** POS → CLINIC. Sent on every status change via webhook. */
export const PrescriptionStatusEventSchema = z.object({
  contractVersion: z.enum(SUPPORTED_CONTRACT_VERSIONS),
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
  /**
   * Present on PRICED/DISPENSED — total the patient pays/paid, in KES cents.
   *
   * Unchanged in meaning by scheme settlement, and that is the point: on a
   * scheme-settled dispensing the patient pays nothing, so this is 0 and the
   * clinician sees the truth — the patient was not charged. What the FARM owes
   * is a different number and travels in `schemeSettled` below.
   */
  totalAmountCents: z.number().int().nonnegative().optional(),
  /**
   * POS → CLINIC, on a dispensing the till did not collect for.
   *
   * This is the till answering the question the clinic deliberately cannot:
   * what the medicines were worth. The clinic posts this onto the farm's
   * statement under the PHARMACY column, so the shelf's prices stay the single
   * source of drug pricing and nothing is maintained twice.
   *
   * Its presence is also the till's receipt for the instruction: the clinic can
   * tell a scheme prescription that was dispensed-without-collecting from one
   * that a cashier charged the patient for by mistake.
   */
  schemeSettled: z
    .object({
      /** Value of the medicines handed over, in KES cents. What the farm owes.
       *  Zero is legitimate — a prescription can be cancelled at the counter
       *  after the shelf was checked — and is not the same as absent. */
      amountCents: z.number().int().nonnegative(),
      /** The till's invoice number — what the farm's finance office will quote
       *  when it queries a line on the statement, and what makes the figure
       *  traceable to a specific sale rather than an assertion. */
      invoiceNo: z.string().min(1),
      /** Echoed from the instruction the till was given, so the clinic can
       *  detect a till settling against a membership the clinic did not name. */
      memberId: z.string().uuid(),
    })
    .optional(),
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
}).superRefine((v, ctx) => {
  // Same interlock as the outbound schema, for the same reason in reverse: a
  // clinic that predates this feature would drop `schemeSettled` on the floor
  // and never bill the farm for the medicines — the blank pharmacy column that
  // cost the facility roughly KES 130,000 in a single month, reappearing by a
  // new route. A 1.1.0 stamp makes an un-upgraded clinic reject the event
  // instead, and the till's outbox keeps it until the clinic can take it.
  if (v.schemeSettled && v.contractVersion === BASELINE_CONTRACT_VERSION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contractVersion'],
      message:
        `a scheme-settled dispensing must be stamped ${CONTRACT_VERSION}: ` +
        `${BASELINE_CONTRACT_VERSION} receivers ignore it and the farm is never billed for the medicines`,
    });
  }
});
export type PrescriptionStatusEvent = z.infer<typeof PrescriptionStatusEventSchema>;
