import Link from 'next/link';
import { CalendarDays, CalendarCheck, UserCheck, UserX, Gauge } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { CAN } from '@/lib/roles';
import {
  buildLanes,
  clinicDateKey,
  clinicDayRange,
  dayStats,
  minutesInClinicDay,
  shiftDateKey,
  type AppointmentRow,
  type Clinician,
} from '@/lib/appointments';
import { AppointmentsBoard } from './AppointmentsBoard';

/**
 * The day view.
 *
 * Server-rendered against a [from, to) window computed in CLINIC time, not the
 * server's UTC — see the timezone note in lib/appointments.ts. The date lives
 * in the URL rather than component state so a particular day can be linked,
 * reloaded and bookmarked, and so navigating days re-runs the audited RPC
 * instead of filtering a client-side cache the audit log never saw.
 */
export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const staff = await requireStaffContext();
  const { date } = await searchParams;

  if (!staff.siteId) {
    return (
      <Card>
        <CardBody className="pt-5">
          <p className="text-sm text-ink-secondary">
            Your account isn&apos;t assigned to a site yet — ask an administrator to add you to one.
          </p>
        </CardBody>
      </Card>
    );
  }

  // A malformed ?date= must not become an invalid Date that silently returns an
  // empty day; anything that isn't a plain calendar key falls back to today.
  const today = clinicDateKey();
  const dateKey = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const { from, to } = clinicDayRange(dateKey);

  const supabase = await supabaseServer();
  const [{ data: apptData, error }, { data: clinData }] = await Promise.all([
    supabase.rpc('list_appointments', {
      p_site_id: staff.siteId,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    }),
    supabase.rpc('list_site_clinicians', { p_site_id: staff.siteId }),
  ]);

  const appointments = (apptData ?? []) as AppointmentRow[];
  const clinicians = (clinData ?? []) as Clinician[];

  const stats = dayStats(appointments, clinicians.length);
  const lanes = buildLanes(appointments, clinicians);

  // The "now" marker belongs on today's schedule only — a now-line on next
  // Tuesday is meaningless. Computed here so the server and the hydrated
  // client place it identically.
  const nowMin = dateKey === today ? minutesInClinicDay(new Date()) : undefined;

  const heading = new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-KE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const dayLink = (d: string) => `/dashboard/appointments?date=${d}`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Appointments</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            {heading}
            {dateKey === today ? ' · today' : ''}
          </p>
        </div>

        <nav className="flex items-center gap-1" aria-label="Change day">
          <Link
            href={dayLink(shiftDateKey(dateKey, -1))}
            className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-hover"
          >
            ← Previous
          </Link>
          <Link
            href={dayLink(today)}
            aria-current={dateKey === today ? 'page' : undefined}
            className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              dateKey === today
                ? 'border-brand bg-brand-wash font-medium text-brand-ink'
                : 'border-line text-ink-secondary hover:bg-surface-hover'
            }`}
          >
            Today
          </Link>
          <Link
            href={dayLink(shiftDateKey(dateKey, 1))}
            className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-hover"
          >
            Next →
          </Link>
        </nav>
      </header>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={`Could not load the schedule: ${error.message}`} />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Booked"
          value={stats.total}
          icon={CalendarDays}
          footnote={stats.unassigned > 0 ? `${stats.unassigned} without a clinician` : 'All have a clinician'}
        />
        <StatTile
          label="Arrived"
          value={stats.arrived}
          icon={UserCheck}
          footnote={`${stats.completed} completed`}
        />
        <StatTile
          label="Did not attend"
          value={stats.noShow}
          icon={UserX}
          higherIsBetter={false}
          footnote={stats.cancelled > 0 ? `${stats.cancelled} cancelled ahead of time` : 'No cancellations'}
        />
        <StatTile
          label="Clinician time booked"
          value={`${Math.round(stats.utilisation * 100)}%`}
          icon={Gauge}
          footnote={
            clinicians.length === 0
              ? 'No clinicians assigned to this site'
              : `Across ${clinicians.length} clinician${clinicians.length === 1 ? '' : 's'}, 8am–5pm`
          }
        />
      </div>

      <Card>
        <CardHeader
          title="Day schedule"
          subtitle={
            stats.total === 0
              ? 'Nothing booked for this day'
              : `${stats.total} appointment${stats.total === 1 ? '' : 's'}`
          }
        />
        <CardBody className="pt-0">
          <AppointmentsBoard
            siteId={staff.siteId}
            dateKey={dateKey}
            appointments={appointments}
            clinicians={clinicians}
            lanes={lanes}
            nowMin={nowMin}
            canBook={CAN.bookAppointment(staff.role)}
          />
        </CardBody>
      </Card>

      {stats.total === 0 && (
        <Card>
          <CardBody className="pt-5">
            <div className="flex items-start gap-3">
              <CalendarCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
              <p className="text-sm text-ink-secondary">
                Nothing is booked for this day yet. Appointments booked here appear on the clinic
                overview, and checking a patient in puts them straight into the triage queue.
              </p>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
