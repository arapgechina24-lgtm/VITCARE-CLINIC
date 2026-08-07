/**
 * Shapes returned by the `get_patient_record` RPC, plus the small amount of
 * clinical interpretation the UI needs.
 */
import type { AllergyStatus, RecordedAllergy } from './allergy-check';

export interface PatientVitals {
  tempC?: string | null;
  bp?: string | null;
  pulseBpm?: string | null;
  spo2Pct?: string | null;
}

export interface RecordEncounter {
  id: string;
  status: 'TRIAGE' | 'IN_CONSULT' | 'COMPLETED' | 'CANCELLED';
  chief_complaint: string | null;
  vitals: PatientVitals | null;
  triage_priority: 'EMERGENCY' | 'URGENT' | 'ROUTINE' | null;
  clinical_notes: string | null;
  created_at: string;
  updated_at: string;
  clinician: string | null;
}

export interface RecordPrescriptionItem {
  id: string;
  drug_name: string;
  strength: string | null;
  dose: string;
  frequency: string;
  duration_days: number | null;
  quantity: number;
  instructions: string | null;
  substitution_allowed: boolean;
  dispensed_quantity: number | null;
  line_status: string | null;
}

export interface RecordPrescription {
  id: string;
  encounter_id: string;
  status: string;
  payer: string;
  note: string | null;
  total_amount_cents: number | null;
  created_at: string;
  prescriber: string | null;
  items: RecordPrescriptionItem[];
}

export interface PatientRecord {
  patient: {
    id: string;
    mrn: string;
    full_name: string;
    dob: string | null;
    sex: string | null;
    phone: string | null;
    national_id: string | null;
    created_at: string;
    /** Optional because rows written before 0010 have no value. Read it
     *  through `allergyStatusOf`, never directly — a missing status must
     *  resolve to UNRECORDED, not to "nothing to worry about". */
    allergy_status?: AllergyStatus | null;
    allergies_reviewed_at?: string | null;
  };
  allergies?: RecordedAllergy[];
  encounters: RecordEncounter[];
  prescriptions: RecordPrescription[];
}

/**
 * The allergy status of a record, defaulting to UNRECORDED.
 *
 * The default is the whole point. A patient registered before allergies
 * existed in this schema has no status, and the only safe reading of "we have
 * no information" is "go and ask" — never an implicit all-clear.
 */
export function allergyStatusOf(record: PatientRecord): AllergyStatus {
  return record.patient.allergy_status ?? 'UNRECORDED';
}

/** Whole years, computed from the date of birth. Null when no DOB is recorded. */
export function ageFrom(dob: string | null): number | null {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const m = now.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < born.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

/**
 * Reference ranges for the four vitals this system records.
 *
 * DELIBERATELY CONSERVATIVE, and deliberately not a diagnosis. These are
 * broad adult screening bands used only to draw attention — an out-of-range
 * value is flagged as "outside the usual range", never as a clinical finding.
 * Paediatric, pregnancy and many chronic-condition norms differ substantially
 * (a resting pulse of 50 is normal in an athlete and concerning in others), so
 * the flag is a prompt for a clinician to look, never a substitute for one.
 */
export type VitalFlag = 'normal' | 'watch' | 'none';

export function flagTemp(v?: string | null): VitalFlag {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return 'none';
  return n >= 36 && n <= 37.5 ? 'normal' : 'watch';
}

export function flagPulse(v?: string | null): VitalFlag {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return 'none';
  return n >= 60 && n <= 100 ? 'normal' : 'watch';
}

export function flagSpo2(v?: string | null): VitalFlag {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return 'none';
  return n >= 95 ? 'normal' : 'watch';
}

export function flagBp(v?: string | null): VitalFlag {
  if (!v) return 'none';
  const m = v.match(/^(\d{2,3})\s*\/\s*(\d{2,3})$/);
  if (!m) return 'none';
  const [sys, dia] = [Number(m[1]), Number(m[2])];
  return sys >= 90 && sys <= 139 && dia >= 60 && dia <= 89 ? 'normal' : 'watch';
}

/** Most recent encounter that still has vitals recorded. */
export function latestVitals(encounters: RecordEncounter[]): { vitals: PatientVitals; at: string } | null {
  for (const e of encounters) {
    if (e.vitals && Object.values(e.vitals).some((v) => v)) {
      return { vitals: e.vitals, at: e.created_at };
    }
  }
  return null;
}

/** The visit currently in progress, if any — notes attach to this. */
export function activeEncounter(encounters: RecordEncounter[]): RecordEncounter | null {
  return encounters.find((e) => e.status === 'TRIAGE' || e.status === 'IN_CONSULT') ?? null;
}
