/**
 * The role model, in one place.
 *
 * This file is the UI's copy of what the database enforces in
 * 0013_role_projected_reads.sql. It exists so pages can hide controls a role
 * cannot use — NOT so pages can decide what a role may see. Those are different
 * jobs, and conflating them is how systems end up with authorization that lives
 * only in a component:
 *
 *   · The DATABASE decides what data is returned. get_patient_record projects
 *     by role, so a receptionist's call never assembles clinical_notes at all.
 *   · This file decides what is worth RENDERING. If it is ever wrong, the
 *     failure is a confusing screen, not a disclosure.
 *
 * Keep the two in agreement, but rely on the first one.
 */

export const ROLES = [
  'ADMIN',
  'CLINICIAN',
  'NURSE',
  'RECEPTIONIST',
  'PHARMACIST',
  'LAB_TECH',
  'AUDITOR',
] as const;

export type Role = (typeof ROLES)[number];

/** How much of a chart the server will return. Mirrors get_patient_record. */
export type RecordScope = 'FULL' | 'OBSERVATIONS' | 'IDENTITY';

const CLINICAL: readonly string[] = ['CLINICIAN', 'ADMIN', 'AUDITOR'];
const OBSERVATIONS: readonly string[] = ['CLINICIAN', 'NURSE', 'ADMIN', 'AUDITOR', 'LAB_TECH'];

export const CAN = {
  /** Notes, diagnoses, prescriptions. */
  readClinical: (role: string) => CLINICAL.includes(role),
  /** Vitals, triage priority, chief complaint. */
  readObservations: (role: string) => OBSERVATIONS.includes(role),
  /** Register a patient and put them in the queue. */
  registerPatient: (role: string) => ['RECEPTIONIST', 'NURSE', 'ADMIN'].includes(role),
  /** Record vitals and set triage priority. */
  triage: (role: string) => ['NURSE', 'CLINICIAN', 'ADMIN'].includes(role),
  /** Write consultation notes. */
  consult: (role: string) => ['CLINICIAN', 'ADMIN'].includes(role),
  /** Issue a prescription. Mirrors can_prescribe() — see 0007. */
  prescribe: (role: string) => ['CLINICIAN', 'ADMIN'].includes(role),
  /** Take an allergy history. A clinical act; reception must not assert it. */
  recordAllergies: (role: string) => ['CLINICIAN', 'NURSE', 'ADMIN'].includes(role),
  /** Book, reschedule, check in or cancel an appointment. Mirrors the role
   *  guard shared by book_appointment / arrive_appointment /
   *  set_appointment_status in 0018 — the desk roles, not the clinical ones. */
  bookAppointment: (role: string) => ['RECEPTIONIST', 'NURSE', 'ADMIN'].includes(role),
  /** Raise, issue and take payment on a clinic invoice. Mirrors the guard
   *  shared by open_invoice_for_encounter / add_invoice_item / issue_invoice /
   *  record_payment in 0021 — the cashier roles. */
  bill: (role: string) => ['RECEPTIONIST', 'ADMIN'].includes(role),
  /** Void an issued invoice. Deliberately narrower than `bill`: writing off a
   *  document that has left the desk is an administrative act. */
  voidInvoice: (role: string) => role === 'ADMIN',
  /** Withdraw a prescription already sent to the pharmacy. Mirrors
   *  cancel_prescription, which gates on can_prescribe() — un-prescribing is
   *  as clinical an act as prescribing. */
  cancelPrescription: (role: string) => ['CLINICIAN', 'ADMIN'].includes(role),
  /** See the CLINIC ↔ POS delivery diagnostics. Error text can carry the POS
   *  base URL and upstream bodies, so it stops at the operators. */
  pharmacyLinkHealth: (role: string) => ['ADMIN', 'AUDITOR'].includes(role),
  /** Read the audit log. */
  audit: (role: string) => ['ADMIN', 'AUDITOR'].includes(role),
} as const;

/** What the server will have returned for this role. */
export function scopeFor(role: string): RecordScope {
  if (CAN.readClinical(role)) return 'FULL';
  if (CAN.readObservations(role)) return 'OBSERVATIONS';
  return 'IDENTITY';
}

/** Human-readable role name for chips and menus. */
export function roleLabel(role: string): string {
  return role === 'LAB_TECH' ? 'Lab technician' : role.charAt(0) + role.slice(1).toLowerCase();
}
