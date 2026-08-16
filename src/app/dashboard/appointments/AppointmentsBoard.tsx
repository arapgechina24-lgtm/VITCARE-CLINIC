'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, Check, Clock, LogIn, X } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import { DaySchedule } from '@/components/dashboard/DaySchedule';
import {
  canArrive,
  canCancel,
  canMarkNoShow,
  clinicInstant,
  findConflict,
  formatMinutes,
  minutesInClinicDay,
  nextFreeSlot,
  type AppointmentRow,
  type AppointmentStatus,
  type Clinician,
  type Lane,
} from '@/lib/appointments';

const TONE: Record<AppointmentStatus, StatusTone> = {
  SCHEDULED: 'neutral',
  CONFIRMED: 'good',
  ARRIVED: 'warning',
  IN_PROGRESS: 'warning',
  COMPLETED: 'good',
  CANCELLED: 'neutral',
  NO_SHOW: 'critical',
};

const LABEL: Record<AppointmentStatus, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  ARRIVED: 'Arrived',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Did not attend',
};

interface PatientHit { id: string; mrn: string; full_name: string; phone: string | null }

export function AppointmentsBoard({
  siteId,
  dateKey,
  appointments,
  clinicians,
  lanes,
  nowMin,
  canBook,
}: {
  siteId: string;
  dateKey: string;
  appointments: AppointmentRow[];
  clinicians: Clinician[];
  lanes: Lane[];
  nowMin?: number;
  canBook: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);

  /** Every mutation follows the same shape: call the RPC, surface its message
   *  verbatim on failure, and re-render from the server on success. The RPCs
   *  translate database errors into instructions ("pick another slot"), so
   *  passing the message straight through is the right call, not laziness. */
  // PromiseLike, not Promise: supabase-js returns a thenable query builder
  // rather than a real promise, so requiring Promise here would force a pointless
  // `await` wrapper around every call site.
  function run(id: string, fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusyId(id);
    setError(null);
    fn().then(({ error }) => {
      setBusyId(null);
      if (error) return setError(error.message);
      startTransition(() => router.refresh());
    });
  }

  const arrive = (a: AppointmentRow) =>
    run(a.id, async () => {
      const { data, error } = await supabase.rpc('arrive_appointment', { p_appointment_id: a.id });
      // The encounter now exists and the patient is in the triage queue —
      // taking the user straight there is the whole point of the integration.
      if (!error && data) router.push(`/dashboard/triage/${data}`);
      return { error };
    });

  const setStatus = (a: AppointmentRow, status: AppointmentStatus, reason?: string) =>
    run(a.id, () =>
      supabase.rpc('set_appointment_status', {
        p_appointment_id: a.id,
        p_status: status,
        p_reason: reason ?? null,
      }),
    );

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-lg bg-critical-wash px-3 py-2">
          <p className="text-xs text-critical-ink">{error}</p>
        </div>
      )}

      <DaySchedule lanes={lanes} nowMin={nowMin} />

      <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink">Bookings</h3>
        {canBook && (
          <button
            type="button"
            onClick={() => setBooking((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
          >
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
            {booking ? 'Close' : 'Book appointment'}
          </button>
        )}
      </div>

      {booking && canBook && (
        <BookAppointmentForm
          siteId={siteId}
          dateKey={dateKey}
          clinicians={clinicians}
          existing={appointments}
          onBooked={() => {
            setBooking(false);
            startTransition(() => router.refresh());
          }}
        />
      )}

      {appointments.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-muted">No bookings for this day.</p>
      ) : (
        <ul className="divide-y divide-line">
          {appointments.map((a) => {
            const startMin = minutesInClinicDay(a.starts_at);
            const busy = busyId === a.id || pending;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="tabular w-[104px] shrink-0 text-xs text-ink-secondary">
                  {formatMinutes(startMin)}
                  <span className="text-ink-muted"> · {a.duration_min}m</span>
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{a.patient_full_name}</p>
                  <p className="truncate text-xs text-ink-muted">
                    <span className="tabular">{a.patient_mrn}</span>
                    {a.clinician_name ? ` · ${a.clinician_name}` : ' · no clinician assigned'}
                    {a.reason ? ` · ${a.reason}` : ''}
                  </p>
                </div>

                <StatusBadge tone={TONE[a.status]} label={LABEL[a.status]} />

                <div className="flex shrink-0 items-center gap-1">
                  {canBook && canArrive(a) && !a.encounter_id && (
                    <Action label="Check in" icon={LogIn} onClick={() => arrive(a)} disabled={busy} />
                  )}
                  {a.encounter_id && (
                    <a
                      href={`/dashboard/triage/${a.encounter_id}`}
                      className="rounded-lg border border-line px-2 py-1 text-2xs text-ink-secondary transition-colors hover:bg-surface-hover"
                    >
                      Open visit
                    </a>
                  )}
                  {canBook && a.status === 'SCHEDULED' && (
                    <Action
                      label="Confirm"
                      icon={Check}
                      onClick={() => setStatus(a, 'CONFIRMED')}
                      disabled={busy}
                    />
                  )}
                  {canBook && canMarkNoShow(a) && (
                    <Action
                      label="No-show"
                      icon={Clock}
                      onClick={() => setStatus(a, 'NO_SHOW', 'Did not attend')}
                      disabled={busy}
                    />
                  )}
                  {canBook && canCancel(a) && (
                    <Action
                      label="Cancel"
                      icon={X}
                      onClick={() => setStatus(a, 'CANCELLED', 'Cancelled at the desk')}
                      disabled={busy}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Action({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: typeof Check;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-2xs text-ink-secondary transition-colors hover:bg-surface-hover disabled:opacity-40"
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </button>
  );
}

function BookAppointmentForm({
  siteId,
  dateKey,
  clinicians,
  existing,
  onBooked,
}: {
  siteId: string;
  dateKey: string;
  clinicians: Clinician[];
  existing: AppointmentRow[];
  onBooked: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [clinicianId, setClinicianId] = useState('');
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState(30);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startMin = useMemo(() => {
    const [h, m] = time.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
  }, [time]);

  // The same rule the database will apply, checked as the form is filled in.
  // This is a courtesy, not the guard — book_appointment() re-checks under a
  // lock, which is the only version that holds when two desks book at once.
  const conflict = useMemo(
    () => findConflict(existing, { clinicianId: clinicianId || null, startMin, durationMin: duration }),
    [existing, clinicianId, startMin, duration],
  );

  const suggestion = useMemo(
    () => (conflict ? nextFreeSlot(existing, clinicianId || null, duration, startMin) : null),
    [conflict, existing, clinicianId, duration, startMin],
  );

  async function search(q: string) {
    setQuery(q);
    setPatient(null);
    if (q.trim().length < 2) return setHits([]);
    const { data } = await supabase.rpc('list_patients', { p_site_id: siteId, p_search: q.trim() });
    setHits(((data ?? []) as PatientHit[]).slice(0, 6));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!patient) return setError('Choose a patient first.');
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('book_appointment', {
      p_patient_id: patient.id,
      p_site_id: siteId,
      p_clinician_id: clinicianId || null,
      p_starts_at: clinicInstant(dateKey, startMin).toISOString(),
      p_duration_min: duration,
      p_reason: reason.trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    onBooked();
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-line bg-surface-sunken p-4">
      <div>
        <label htmlFor="appt-patient" className="mb-1 block text-xs font-medium text-ink-secondary">
          Patient
        </label>
        {patient ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink">{patient.full_name}</span>
            <span className="tabular text-xs text-ink-muted">{patient.mrn}</span>
            <button
              type="button"
              onClick={() => { setPatient(null); setQuery(''); }}
              className="text-2xs text-brand-ink underline"
            >
              change
            </button>
          </div>
        ) : (
          <>
            <input
              id="appt-patient"
              value={query}
              onChange={(e) => search(e.target.value)}
              placeholder="Search by name or MRN"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
            {hits.length > 0 && (
              <ul className="mt-1 divide-y divide-line rounded-lg border border-line bg-surface">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => { setPatient(h); setHits([]); }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover"
                    >
                      <span className="flex-1 truncate text-ink">{h.full_name}</span>
                      <span className="tabular text-xs text-ink-muted">{h.mrn}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="appt-clinician" className="mb-1 block text-xs font-medium text-ink-secondary">
            Clinician
          </label>
          <select
            id="appt-clinician"
            value={clinicianId}
            onChange={(e) => setClinicianId(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            <option value="">First available</option>
            {clinicians.map((c) => (
              <option key={c.id} value={c.id}>{c.full_name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="appt-time" className="mb-1 block text-xs font-medium text-ink-secondary">
            Start
          </label>
          <input
            id="appt-time"
            type="time"
            step={300}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>
        <div>
          <label htmlFor="appt-duration" className="mb-1 block text-xs font-medium text-ink-secondary">
            Duration
          </label>
          <select
            id="appt-duration"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            {[15, 20, 30, 45, 60, 90].map((d) => (
              <option key={d} value={d}>{d} minutes</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="appt-reason" className="mb-1 block text-xs font-medium text-ink-secondary">
          Reason
        </label>
        <input
          id="appt-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Hypertension review"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
        />
        <p className="mt-1 text-2xs text-ink-muted">
          Carried onto the visit as the chief complaint when the patient checks in.
        </p>
      </div>

      {conflict && (
        <div className="rounded-lg bg-warning-wash px-3 py-2">
          <p className="text-xs text-warning-ink">
            {conflict.clinician_name ?? 'That clinician'} already has {conflict.patient_full_name} at{' '}
            {formatMinutes(minutesInClinicDay(conflict.starts_at))}.
            {suggestion != null ? (
              <>
                {' '}Next free slot is{' '}
                <button
                  type="button"
                  onClick={() => setTime(
                    `${String(Math.floor(suggestion / 60)).padStart(2, '0')}:${String(suggestion % 60).padStart(2, '0')}`,
                  )}
                  className="font-medium underline"
                >
                  {formatMinutes(suggestion)}
                </button>
                .
              </>
            ) : (
              ' No free slot left for this clinician today.'
            )}
          </p>
        </div>
      )}

      {error && <p className="text-xs text-critical-ink">{error}</p>}

      <button
        type="submit"
        disabled={busy || !patient}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
      >
        {busy ? 'Booking…' : 'Book appointment'}
      </button>
    </form>
  );
}
