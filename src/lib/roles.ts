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
