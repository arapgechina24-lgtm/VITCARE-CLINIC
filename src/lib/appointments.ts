/**
 * Appointments — the parts that are just arithmetic.
 *
 * Everything here is pure and tested. The database owns authorization and
 * conflict *enforcement* (0018_appointments.sql); this file owns the shape of
 * a day, so the UI can lay out a timeline and warn about a clash before the
 * user submits. The overlap rule below is deliberately the same rule the
 * exclusion constraint applies — if the two ever disagree, the database wins
 * and the user sees an error they were not warned about, which is the failure
 * mode this duplication exists to avoid. Keep them in step.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 * This is the sharp edge. The clinic is in Naivasha; the server that renders
 * these pages is a Netlify function running in UTC. `new Date(iso).getHours()`
 * therefore returns a UTC hour on the server and a Nairobi hour in the
 * browser, so a 9am appointment renders at 6am on a server-rendered timeline
 * and jumps three hours when React hydrates. Every clock reading in this
 * module goes through CLINIC_TZ instead of the host's locale, so the server
 * and the browser agree.
 */

/** Kenya has been UTC+03:00 since 1960 and observes no DST, but this is
 *  resolved through Intl rather than hardcoded as +3: an offset constant is a
 *  fact that can silently rot, whereas a tz identifier is one the platform
 *  keeps current. */
export const CLINIC_TZ = 'Africa/Nairobi';

/** Timeline bounds — a clinic day, not a 24h axis nobody looks at. */
export const DAY_START_MIN = 8 * 60;
export const DAY_END_MIN = 17 * 60;

export type AppointmentStatus =
  | 'SCHEDULED'
  | 'CONFIRMED'
  | 'ARRIVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

/** One row of list_appointments(). Field names match the RPC exactly. */
export interface AppointmentRow {
  id: string;
  patient_id: string;
  patient_full_name: string;
  patient_mrn: string;
  patient_phone: string | null;
  clinician_id: string | null;
  clinician_name: string | null;
  starts_at: string;
  duration_min: number;
  reason: string | null;
  status: AppointmentStatus;
  encounter_id: string | null;
}

export interface Clinician {
  id: string;
  full_name: string;
  role: string;
}

/**
 * The statuses that occupy a clinician's time. Must match the WHERE clause on
 * appointments_no_double_booking — a cancelled slot is free to re-book, and
 * the constraint agrees.
 */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  'SCHEDULED',
  'CONFIRMED',
  'ARRIVED',
  'IN_PROGRESS',
];

export const isBlocking = (s: AppointmentStatus) => BLOCKING_STATUSES.includes(s);

/** Terminal states — no further transition, and nothing to act on. */
export const isClosed = (s: AppointmentStatus) =>
  s === 'COMPLETED' || s === 'CANCELLED' || s === 'NO_SHOW';

/** Mirrors arrive_appointment()'s guard. */
export const canArrive = (a: Pick<AppointmentRow, 'status'>) =>
  a.status !== 'CANCELLED' && a.status !== 'NO_SHOW' && a.status !== 'COMPLETED';

/** Mirrors set_appointment_status()'s guard: closed appointments are closed. */
export const canCancel = (a: Pick<AppointmentRow, 'status'>) =>
  a.status !== 'COMPLETED' && a.status !== 'CANCELLED';

/** A no-show can only be asserted for someone who never arrived. Marking a
 *  patient absent after they have been seen is a data-entry accident, not a
 *  workflow. */
export const canMarkNoShow = (a: Pick<AppointmentRow, 'status'>) =>
  a.status === 'SCHEDULED' || a.status === 'CONFIRMED';

// ── Clock, in clinic time ───────────────────────────────────────────────────

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLINIC_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

interface ClinicParts {
  year: number; month: number; day: number; hour: number; minute: number;
}

function clinicParts(at: Date): ClinicParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  // `hour12: false` yields 24 rather than 0 for midnight in some ICU versions;
  // normalising here keeps every downstream minute calculation in [0, 1440).
  return {
    year: out.year, month: out.month, day: out.day,
    hour: out.hour % 24, minute: out.minute,
  };
}

/** Minutes from clinic-local midnight. The timeline's x-axis unit. */
export function minutesInClinicDay(at: Date | string): number {
  const p = clinicParts(typeof at === 'string' ? new Date(at) : at);
  return p.hour * 60 + p.minute;
}

/** Clinic-local calendar date as YYYY-MM-DD — the value a `<input type=date>`
 *  round-trips and the key a day view is addressed by. */
export function clinicDateKey(at: Date | string = new Date()): string {
  const p = clinicParts(typeof at === 'string' ? new Date(at) : at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The UTC instants bounding one clinic day, for the RPC's [from, to) window.
 *
 * Built by probing the offset with Intl rather than assuming +03:00, so this
 * stays correct if the clinic tz is ever changed to somewhere with DST.
 */
export function clinicDayRange(dateKey: string): { from: Date; to: Date } {
  const [y, m, d] = dateKey.split('-').map(Number);
  // Start from the naive UTC instant, measure how far the clinic clock is from
  // it, then shift back by that much. One correction is enough: the offset at
  // a given wall-clock date does not itself depend on the correction.
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  const p = clinicParts(new Date(naive));
  const asClinic = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const offset = asClinic - naive;
  const from = new Date(naive - offset);
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * The instant at which `minutes` past clinic midnight on `dateKey` occurs.
 *
 * The inverse of minutesInClinicDay(), and the value the booking form sends as
 * starts_at. Going through clinicDayRange() rather than composing a local Date
 * is what keeps a 9:00am booking made from a UTC server 9:00am in Naivasha.
 */
export function clinicInstant(dateKey: string, minutes: number): Date {
  return new Date(clinicDayRange(dateKey).from.getTime() + minutes * 60_000);
}

/** Shift a YYYY-MM-DD key by whole days without tripping over month ends. */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** `540` → `9:00am`. Used on the axis, in blocks, and in aria-labels. */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

// ── Overlap and planning ────────────────────────────────────────────────────

interface Span { startMin: number; durationMin: number }

/**
 * Half-open overlap: an appointment ending at 9:00 does not clash with one
 * starting at 9:00. This is exactly `&&` on tstzrange, whose upper bound is
 * exclusive — matching it is what keeps back-to-back slots bookable.
 */
export function overlaps(a: Span, b: Span): boolean {
  return a.startMin < b.startMin + b.durationMin && b.startMin < a.startMin + a.durationMin;
}

/**
 * The appointment a proposed booking would collide with, or null.
 *
 * Only ever consults blocking statuses and the same clinician, because those
 * are the two conditions in the constraint's WHERE clause. An unassigned
 * candidate (no clinician) cannot clash — it is not yet anybody's time.
 */
export function findConflict(
  existing: readonly AppointmentRow[],
  candidate: { clinicianId: string | null; startMin: number; durationMin: number; ignoreId?: string },
): AppointmentRow | null {
  if (!candidate.clinicianId) return null;
  for (const a of existing) {
    if (a.id === candidate.ignoreId) continue;
    if (a.clinician_id !== candidate.clinicianId) continue;
    if (!isBlocking(a.status)) continue;
    const span = { startMin: minutesInClinicDay(a.starts_at), durationMin: a.duration_min };
    if (overlaps(span, candidate)) return a;
  }
  return null;
}

/**
 * The earliest slot of `durationMin` that a clinician could actually take,
 * searched on a 15-minute grid within clinic hours.
 *
 * This is the module's answer to "helps us plan better": the alternative is a
 * receptionist guessing a time, being rejected by the constraint, and guessing
 * again with a patient standing in front of them. Returns null when the day
 * genuinely has no room, which is itself the useful answer — it means offer
 * another day rather than hunt further.
 */
export function nextFreeSlot(
  existing: readonly AppointmentRow[],
  clinicianId: string | null,
  durationMin: number,
  notBeforeMin: number = DAY_START_MIN,
): number | null {
  const step = 15;
  const first = Math.max(DAY_START_MIN, Math.ceil(notBeforeMin / step) * step);
  for (let start = first; start + durationMin <= DAY_END_MIN; start += step) {
    if (!findConflict(existing, { clinicianId, startMin: start, durationMin })) return start;
  }
  return null;
}

/** One timeline lane. Unassigned appointments get their own lane rather than
 *  being hidden — an unstaffed booking is the thing a planner most needs to
 *  see, not the thing to omit for tidiness. */
export interface Lane {
  clinicianId: string | null;
  name: string;
  role: string | null;
  appointments: AppointmentRow[];
}

export function buildLanes(
  appointments: readonly AppointmentRow[],
  clinicians: readonly Clinician[],
): Lane[] {
  const lanes: Lane[] = clinicians.map((c) => ({
    clinicianId: c.id,
    name: c.full_name,
    role: c.role,
    appointments: [],
  }));
  const byId = new Map(lanes.map((l) => [l.clinicianId, l]));

  const unassigned: Lane = { clinicianId: null, name: 'Unassigned', role: null, appointments: [] };

  for (const a of appointments) {
    if (isClosed(a.status) && a.status !== 'COMPLETED') continue; // cancelled/no-show leave no gap
    const lane = a.clinician_id ? byId.get(a.clinician_id) : undefined;
    (lane ?? unassigned).appointments.push(a);
  }

  // A clinician with nothing booked still gets a lane — an empty row is how a
  // planner sees available capacity. The unassigned lane is the exception: it
  // is noise when empty, so it appears only when it holds something.
  return unassigned.appointments.length > 0 ? [...lanes, unassigned] : lanes;
}

export interface DayStats {
  total: number;
  arrived: number;
  completed: number;
  noShow: number;
  cancelled: number;
  unassigned: number;
  /** Booked clinician-minutes as a share of clinic-hour capacity, 0–1. */
  utilisation: number;
}

export function dayStats(
  appointments: readonly AppointmentRow[],
  clinicianCount: number,
): DayStats {
  const capacity = clinicianCount * (DAY_END_MIN - DAY_START_MIN);
  const booked = appointments
    .filter((a) => isBlocking(a.status) || a.status === 'COMPLETED')
    .reduce((sum, a) => sum + a.duration_min, 0);

  return {
    total: appointments.length,
    arrived: appointments.filter((a) => a.status === 'ARRIVED' || a.status === 'IN_PROGRESS').length,
    completed: appointments.filter((a) => a.status === 'COMPLETED').length,
    noShow: appointments.filter((a) => a.status === 'NO_SHOW').length,
    cancelled: appointments.filter((a) => a.status === 'CANCELLED').length,
    unassigned: appointments.filter((a) => !a.clinician_id && isBlocking(a.status)).length,
    utilisation: capacity > 0 ? Math.min(1, booked / capacity) : 0,
  };
}
