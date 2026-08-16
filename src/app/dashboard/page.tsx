import Link from 'next/link';
import { ArrowRight, CalendarDays, ClipboardList, Pill, Users } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import { DaySchedule } from '@/components/dashboard/DaySchedule';
import {
  buildLanes,
  clinicDateKey,
  clinicDayRange,
  dayStats,
  minutesInClinicDay,
  type AppointmentRow,
  type Clinician,
} from '@/lib/appointments';

type EncounterRow = {
  id: string;
  patient_full_name: string;
  patient_mrn: string;
  status: string;
  chief_complaint: string | null;
  triage_priority: string | null;
  created_at: string;
};

/** Triage priority → status tone. EMERGENCY is the only thing that gets the
 *  loudest colour in the whole UI; if everything is critical, nothing is. */
const PRIORITY_TONE: Record<string, StatusTone> = {
  EMERGENCY: 'critical',
  URGENT: 'serious',
  ROUTINE: 'neutral',
};

const STAGE: Record<string, { label: string; tone: StatusTone; href: (id: string) => string }> = {
  TRIAGE: { label: 'Awaiting triage', tone: 'warning', href: (id) => `/dashboard/triage/${id}` },
  IN_CONSULT: { label: 'Ready for consult', tone: 'good', href: (id) => `/dashboard/consult/${id}` },
};

export default async function OverviewPage() {
  const staff = await requireStaffContext();

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

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('list_encounters', { p_site_id: staff.siteId });
  const encounters = (data ?? []) as EncounterRow[];

  // ── Real figures, from the database ──────────────────────────────────────
  // A single clock read for the whole render: "today" and every queue wait are
  // then measured against the same instant, rather than each row sampling its
  // own slightly-later timestamp.
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todays = encounters.filter((e) => new Date(e.created_at) >= startOfToday);
  const completedToday = todays.filter((e) => e.status === 'COMPLETED').length;

  // Real 12-day volume trend, bucketed from the encounters we already hold —
  // no extra query. If there isn't enough history to show a shape yet, the
  // sparkline is omitted entirely rather than drawn flat: a fabricated trend
  // under a real number is worse than no trend at all.
  const dayBuckets: number[] = Array.from({ length: 12 }, (_, i) => {
    const from = new Date(startOfToday);
    from.setDate(from.getDate() - (11 - i));
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return encounters.filter((e) => {
      const at = new Date(e.created_at);
      return at >= from && at < to;
    }).length;
  });
  const daysWithActivity = dayBuckets.filter((n) => n > 0).length;
  const volumeTrend = daysWithActivity >= 3 ? dayBuckets : undefined;

  const renderedAt = now.getTime();
  const waiting = encounters
    .filter((e) => e.status === 'TRIAGE' || e.status === 'IN_CONSULT')
    .map((e) => ({
      ...e,
      waitedMinutes: Math.max(0, Math.round((renderedAt - new Date(e.created_at).getTime()) / 60000)),
    }));

  // Prescriptions still awaiting the pharmacy. Counted via a head-only query —
  // we need the number, not the rows, and prescriptions carry clinical detail.
  const { count: pendingRx } = await supabase
    .from('prescriptions')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', staff.siteId)
    .in('status', ['PENDING', 'PRICED', 'PARTIAL', 'OUT_OF_STOCK']);

  // Today's schedule, from the real appointments module. The window is a CLINIC
  // day, not a server day — this renders on a UTC function, and `startOfToday`
  // above is deliberately left alone because it buckets encounters by the same
  // server clock that created them.
  const todayKey = clinicDateKey();
  const { from: dayFrom, to: dayTo } = clinicDayRange(todayKey);
  const [{ data: apptData }, { data: clinData }] = await Promise.all([
    supabase.rpc('list_appointments', {
      p_site_id: staff.siteId,
      p_from: dayFrom.toISOString(),
      p_to: dayTo.toISOString(),
    }),
    supabase.rpc('list_site_clinicians', { p_site_id: staff.siteId }),
  ]);
  const appointments = (apptData ?? []) as AppointmentRow[];
  const clinicians = (clinData ?? []) as Clinician[];
  const apptStats = dayStats(appointments, clinicians.length);
  const lanes = buildLanes(appointments, clinicians);

  const firstName = staff.fullName.split(' ')[0];
  const today = new Date().toLocaleDateString('en-KE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Good day, {firstName}</h1>
        <p className="mt-0.5 text-sm text-ink-muted">{today}</p>
      </header>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={`Could not load the queue: ${error.message}`} />
          </CardBody>
        </Card>
      )}

      {/* KPI row. Only the first two are real; the third is explicitly marked,
          because a number that looks live but isn't is worse than no number. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Patients today"
          value={todays.length}
          icon={Users}
          trend={volumeTrend}
          footnote={
            volumeTrend ? `${completedToday} completed` : `${completedToday} completed · trend builds with use`
          }
        />
        <StatTile
          label="In the queue now"
          value={waiting.length}
          icon={ClipboardList}
          footnote={waiting.length === 0 ? 'Nothing waiting' : 'Awaiting triage or consult'}
        />
        <StatTile
          label="Pending pharmacy orders"
          value={pendingRx ?? 0}
          icon={Pill}
          higherIsBetter={false}
          footnote="Sent to the pharmacy, not yet collected"
        />
        <StatTile
          label="Appointments today"
          value={apptStats.total}
          icon={CalendarDays}
          footnote={
            apptStats.total === 0
              ? 'Nothing booked today'
              : `${apptStats.arrived} arrived · ${apptStats.noShow} did not attend`
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* Live queue — the thing this screen actually exists for. */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="Patient queue"
            subtitle={waiting.length === 0 ? 'Nobody waiting' : `${waiting.length} waiting`}
            action={
              <Link
                href="/dashboard/register"
                className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
              >
                Register patient
              </Link>
            }
          />
          <CardBody className="pt-0">
            {waiting.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line-strong py-10 text-center">
                <p className="text-sm text-ink-secondary">The queue is clear.</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Newly registered patients appear here for triage.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {waiting.map((e) => {
                  const stage = STAGE[e.status];
                  return (
                    <li key={e.id}>
                      <Link
                        href={stage?.href(e.id) ?? '/dashboard'}
                        className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-surface-hover"
                      >
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-sunken text-2xs font-semibold text-ink-secondary">
                          {e.patient_full_name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
                        </span>

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">{e.patient_full_name}</p>
                          <p className="truncate text-xs text-ink-muted">
                            <span className="tabular">{e.patient_mrn}</span>
                            {e.chief_complaint ? ` · ${e.chief_complaint}` : ''}
                          </p>
                        </div>

                        <div className="hidden shrink-0 items-center gap-2 sm:flex">
                          {e.triage_priority && (
                            <StatusBadge
                              tone={PRIORITY_TONE[e.triage_priority] ?? 'neutral'}
                              label={e.triage_priority}
                            />
                          )}
                          {stage && <StatusBadge tone={stage.tone} label={stage.label} />}
                          <span className="tabular w-14 text-right text-2xs text-ink-muted">
                            {e.waitedMinutes}m
                          </span>
                        </div>

                        <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Recently completed — a quiet confirmation that work is flowing. */}
        <Card>
          <CardHeader title="Completed today" subtitle={`${completedToday} visit${completedToday === 1 ? '' : 's'}`} />
          <CardBody className="pt-0">
            {completedToday === 0 ? (
              <p className="py-8 text-center text-xs text-ink-muted">No completed visits yet today.</p>
            ) : (
              <ul className="divide-y divide-line">
                {todays
                  .filter((e) => e.status === 'COMPLETED')
                  .slice(0, 6)
                  .map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink">{e.patient_full_name}</p>
                        <p className="truncate text-2xs text-ink-muted tabular">{e.patient_mrn}</p>
                      </div>
                      <StatusBadge tone="good" label="Done" />
                    </li>
                  ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Today's clinicians"
          subtitle="Consulting-room schedule"
          action={
            <Link
              href="/dashboard/appointments"
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface-hover"
            >
              Open appointments
            </Link>
          }
        />
        <CardBody className="pt-0">
          <DaySchedule lanes={lanes} nowMin={minutesInClinicDay(now)} />
        </CardBody>
      </Card>
    </div>
  );
}
