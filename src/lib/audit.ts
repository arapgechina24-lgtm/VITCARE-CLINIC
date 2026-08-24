/**
 * The audit log, made readable.
 *
 * Entries are written for machines: `{"fn":"list_patients","site_id":"d9f3…"}`.
 * The people who need to read them are a clinic manager and, eventually, an
 * inspector — neither of whom should have to know that `list_patients` is the
 * function behind the patient search box.
 *
 * So this file turns a row into a sentence. It is presentation only: nothing
 * here filters, hides or re-interprets what was recorded, because an audit
 * trail that a rendering layer can quietly edit is not one. Where a row is not
 * recognised it says so plainly and shows the raw action rather than inventing
 * a friendly label for something it does not understand.
 */

import { clinicDayRange, clinicDateKey, shiftDateKey } from './appointments';

export interface AuditEntry {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  table_name: string;
  record_id: string | null;
  patient_id: string | null;
  patient_name: string | null;
  patient_mrn: string | null;
  details: Record<string, unknown> | null;
}

/** Reads are noise until you are looking for one; writes are what changed the
 *  record. Worth telling apart at a glance. */
export type AuditKind = 'read' | 'write' | 'event';

export function auditKind(action: string): AuditKind {
  if (action === 'SELECT') return 'read';
  if (action === 'INSERT' || action === 'UPDATE' || action === 'DELETE') return 'write';
  return 'event';
}

export const ACTION_LABEL: Record<string, string> = {
  SELECT: 'Viewed',
  INSERT: 'Created',
  UPDATE: 'Changed',
  DELETE: 'Removed',
};

/**
 * The function name recorded in `details.fn` → what a person did.
 *
 * Only functions that actually write an audit entry appear here. The list is
 * deliberately explicit rather than derived from the name: `submit_triage`
 * reads as "Recorded triage", not "Submit triage", and no amount of string
 * manipulation gets there.
 */
const FN_LABEL: Record<string, string> = {
  list_patients: 'Searched the patient list',
  list_patients_summary: 'Opened the patient list',
  get_patient: 'Opened a patient',
  get_patient_record: 'Opened a patient record',
  list_encounters: 'Opened the visit queue',
  list_appointments: 'Opened the appointment schedule',
  list_pharmacy_queue: 'Opened the pharmacy queue',
  list_invoices: 'Opened the invoice list',
  get_invoice: 'Opened an invoice',
  list_encounter_services: 'Viewed services recorded at a visit',
  list_audit_log: 'Read the audit log',
  register_patient: 'Registered a patient',
  submit_triage: 'Recorded triage',
  save_consult_notes: 'Saved consultation notes',
  submit_prescription: 'Issued a prescription',
  cancel_prescription: 'Cancelled a prescription',
  set_patient_allergies: 'Updated an allergy history',
  book_appointment: 'Booked an appointment',
  reschedule_appointment: 'Rescheduled an appointment',
  set_appointment_status: 'Changed an appointment status',
  arrive_appointment: 'Checked a patient in',
  record_encounter_service: 'Recorded a service performed',
  set_user_license: 'Changed a practitioner licence',
  set_user_role: 'Changed a staff role',
  set_user_active: 'Activated or deactivated a staff account',
  set_service_module_active: 'Switched a service module on or off',
};

/**
 * One line describing what happened, for someone who does not know the
 * schema. Falls back to the raw action and table rather than guessing.
 */
export function describeAuditEntry(e: Pick<AuditEntry, 'action' | 'table_name' | 'details'>): string {
  const fn = typeof e.details?.fn === 'string' ? e.details.fn : null;
  if (fn && FN_LABEL[fn]) return FN_LABEL[fn];

  // Domain events carry their meaning in the action itself
  // (e.g. 'prescription.out_of_stock' from the POS status webhook).
  if (e.action.includes('.')) {
    return e.action
      .split('.')
      .map((part) => part.replace(/_/g, ' '))
      .join(' — ')
      .replace(/^./, (c) => c.toUpperCase());
  }

  const verb = ACTION_LABEL[e.action] ?? e.action;
  return `${verb} ${e.table_name.replace(/_/g, ' ')}`;
}

/** Extra context worth showing beside the sentence — the search term used, the
 *  module toggled, who was affected. Empty when there is nothing useful. */
export function auditContext(e: Pick<AuditEntry, 'details'>): string {
  const d = e.details;
  if (!d) return '';
  const bits: string[] = [];
  const str = (k: string) => (typeof d[k] === 'string' && d[k] ? String(d[k]) : null);

  const search = str('search');
  if (search) bits.push(`“${search}”`);
  const subject = str('subject');
  if (subject) bits.push(subject);
  // Not `module`: Next.js reserves that identifier (it is CommonJS's), and
  // @next/next/no-assign-module-variable rejects binding it even in an ES module.
  const moduleName = str('module');
  if (moduleName) bits.push(moduleName.replace('Conditional - ', ''));
  if (typeof d.active === 'boolean') bits.push(d.active ? 'switched on' : 'switched off');
  if (typeof d.has_licence === 'boolean') bits.push(d.has_licence ? 'licence recorded' : 'licence cleared');
  const from = str('from');
  const to = str('to');
  if (from && to) bits.push(`${from} → ${to}`);
  const status = str('status');
  if (status) bits.push(status);

  return bits.join(' · ');
}

/** Clinic-local windows for the date filter. Uses the same Africa/Nairobi
 *  helpers as the schedule, so "today" means the clinic's today and not the
 *  browser's. */
export function auditRange(preset: 'today' | '7d' | '30d' | 'all'):
  { from: string | null; to: string | null } {
  if (preset === 'all') return { from: null, to: null };
  const todayKey = clinicDateKey();
  const { to } = clinicDayRange(todayKey);
  const backBy = preset === 'today' ? 0 : preset === '7d' ? 6 : 29;
  const { from } = clinicDayRange(shiftDateKey(todayKey, -backBy));
  return { from: from.toISOString(), to: to.toISOString() };
}

export const RANGE_LABEL: Record<'today' | '7d' | '30d' | 'all', string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'Everything',
};
