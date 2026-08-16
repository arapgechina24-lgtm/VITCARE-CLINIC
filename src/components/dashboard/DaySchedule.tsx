'use client';
import { useState } from 'react';
import {
  DAY_START_MIN,
  DAY_END_MIN,
  formatMinutes,
  minutesInClinicDay,
  type AppointmentStatus,
  type Lane,
} from '@/lib/appointments';

/**
 * The day's clinicians as a horizontal timeline — one row per clinician.
 *
 * A deliberate design decision: appointment blocks are ALL one hue, not
 * coloured per clinician. Each clinician already has their own labelled row,
 * so colouring by clinician would be redundant encoding — it adds visual noise
 * without adding information, and it would burn a categorical palette on
 * something the layout already says. Colour here is reserved for *state*
 * (in progress, arrived), which the row layout cannot express.
 *
 * Status is carried by fill + a text label inside the block, never by hue
 * alone, so it survives colour-vision deficiency and greyscale printing.
 *
 * Every time value comes from the clinic-time helpers rather than the host
 * clock: this renders on a Netlify function in UTC and then hydrates in a
 * browser in Nairobi, and a timeline that moves three hours on hydration is
 * worse than no timeline.
 */

const STATUS_STYLE: Record<AppointmentStatus, { block: string; label: string; text: string }> = {
  SCHEDULED: { block: 'bg-surface border-line-strong border-dashed', label: 'Scheduled', text: 'text-ink-secondary' },
  CONFIRMED: { block: 'bg-brand-wash border-brand/20', label: 'Confirmed', text: 'text-brand-ink' },
  ARRIVED: { block: 'bg-warning-wash border-warning/30', label: 'Arrived', text: 'text-warning-ink' },
  IN_PROGRESS: { block: 'bg-brand-wash-strong border-brand/30', label: 'In progress', text: 'text-brand-ink' },
  COMPLETED: { block: 'bg-surface-sunken border-line', label: 'Done', text: 'text-ink-muted' },
  // Neither reaches the timeline (buildLanes drops them), but the map must be
  // total or a status added later renders as an unstyled block.
  CANCELLED: { block: 'bg-surface-sunken border-line', label: 'Cancelled', text: 'text-ink-muted' },
  NO_SHOW: { block: 'bg-critical-wash border-critical/30', label: 'No-show', text: 'text-critical-ink' },
};

/** The four states a block can actually be drawn in — the legend should not
 *  advertise states the timeline never shows. */
const LEGEND: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'];

const HOURS = Array.from(
  { length: Math.floor((DAY_END_MIN - DAY_START_MIN) / 60) + 1 },
  (_, i) => DAY_START_MIN + i * 60,
);

const hourLabel = (min: number) => {
  const h = Math.floor(min / 60);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${suffix}`;
};

const pct = (min: number) => ((min - DAY_START_MIN) / (DAY_END_MIN - DAY_START_MIN)) * 100;

export function DaySchedule({
  lanes,
  /** Clinic-local now, in minutes. Passed in rather than read here so the
   *  server and the client agree on where the marker goes. Omit to hide it. */
  nowMin,
  onSelect,
}: {
  lanes: Lane[];
  nowMin?: number;
  onSelect?: (appointmentId: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  // Detail for the hovered/focused block is shown in a fixed strip BELOW the
  // timeline rather than in a floating tooltip. The timeline scrolls
  // horizontally, and a scroll container clips on both axes — CSS can't do
  // `overflow-x: auto; overflow-y: visible` — so an anchored tooltip was
  // getting cut off by the container edge. A stable strip also reads better on
  // a clinic screen (the detail is always in the same place instead of chasing
  // the cursor), and works for touch and keyboard focus, which tooltips don't.
  const active = lanes
    .flatMap((l) => l.appointments.map((a) => ({ ...a, lane: l.name })))
    .find((a) => a.id === hovered);

  const nowVisible = nowMin != null && nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN;

  if (lanes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong py-10 text-center">
        <p className="text-sm text-ink-secondary">No clinicians are assigned to this site yet.</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          An administrator adds staff to a site before the schedule can show rows.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          {/* Hour axis */}
          <div className="relative mb-2 ml-[168px] h-4">
            {HOURS.map((h) => (
              <span
                key={h}
                className="absolute -translate-x-1/2 text-2xs tabular text-ink-muted"
                style={{ left: `${pct(h)}%` }}
              >
                {hourLabel(h)}
              </span>
            ))}
          </div>

          <div className="space-y-2">
            {lanes.map((lane) => (
              <div key={lane.clinicianId ?? 'unassigned'} className="flex items-stretch gap-3">
                {/* Row label — this is what carries clinician identity, not colour. */}
                <div className="w-[156px] shrink-0 py-1">
                  <p className="truncate text-xs font-medium text-ink">{lane.name}</p>
                  <p className="truncate text-2xs text-ink-muted">
                    {lane.role
                      ? lane.role.charAt(0) + lane.role.slice(1).toLowerCase()
                      : 'Needs a clinician'}
                  </p>
                </div>

                <div className="relative h-14 flex-1 rounded-lg bg-surface-sunken">
                  {/* Recessive hour gridlines */}
                  {HOURS.map((h) => (
                    <span
                      key={h}
                      className="absolute inset-y-0 w-px bg-line"
                      style={{ left: `${pct(h)}%` }}
                      aria-hidden
                    />
                  ))}

                  {nowVisible && (
                    <span
                      className="absolute inset-y-0 z-10 w-0.5 bg-critical"
                      style={{ left: `${pct(nowMin!)}%` }}
                      aria-hidden
                    />
                  )}

                  {lane.appointments.map((a) => {
                    const s = STATUS_STYLE[a.status];
                    const startMin = minutesInClinicDay(a.starts_at);
                    const left = pct(startMin);
                    const width = (a.duration_min / (DAY_END_MIN - DAY_START_MIN)) * 100;
                    // A 30-minute block is ~50px wide on a desktop row — enough
                    // for a truncated name and nothing else. Cramming the status
                    // in too produced "Ma… / Done", which tells you neither. Short
                    // blocks show the name alone; the detail strip carries the rest.
                    const roomy = a.duration_min >= 45;
                    // An appointment outside clinic hours would otherwise be drawn
                    // at a negative offset and vanish off the left edge.
                    const offAxis = startMin < DAY_START_MIN || startMin >= DAY_END_MIN;
                    if (offAxis) return null;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onMouseEnter={() => setHovered(a.id)}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(a.id)}
                        onBlur={() => setHovered(null)}
                        onClick={() => onSelect?.(a.id)}
                        // Inset by 1px each side so adjacent blocks show a surface
                        // gap rather than fusing into one bar.
                        className={`group absolute top-1.5 bottom-1.5 rounded-md border px-2 text-left transition-shadow hover:shadow-md ${s.block} ${
                          roomy ? '' : 'flex items-center'
                        }`}
                        style={{ left: `calc(${left}% + 1px)`, width: `calc(${width}% - 2px)` }}
                        aria-label={`${a.patient_full_name}, ${a.reason ?? 'no reason given'}, ${formatMinutes(startMin)} for ${a.duration_min} minutes, ${s.label}`}
                      >
                        <span className="block w-full overflow-hidden">
                          <span className={`block truncate text-2xs font-medium ${s.text}`}>
                            {a.patient_full_name}
                          </span>
                          {roomy && <span className="block truncate text-2xs text-ink-muted">{s.label}</span>}
                        </span>

                        {hovered === a.id && (
                          <span className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-brand/40" aria-hidden />
                        )}
                      </button>
                    );
                  })}

                  {lane.appointments.length === 0 && (
                    <span className="absolute inset-0 grid place-items-center text-2xs text-ink-muted">
                      Free all day
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Legend — always present, because these states are colour-coded and
              identity must never be colour-alone. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
            {LEGEND.map((k) => (
              <span key={k} className="flex items-center gap-1.5 text-2xs text-ink-secondary">
                <span className={`h-2.5 w-2.5 rounded border ${STATUS_STYLE[k].block}`} aria-hidden />
                {STATUS_STYLE[k].label}
              </span>
            ))}
            {nowVisible && (
              <span className="flex items-center gap-1.5 text-2xs text-ink-secondary">
                <span className="h-2.5 w-0.5 bg-critical" aria-hidden />
                Now
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Detail strip. Fixed height so hovering across blocks doesn't make the
          card jump — layout shift under the cursor is disorienting. */}
      <div className="mt-3 flex min-h-[52px] items-center rounded-lg bg-surface-sunken px-3 py-2" aria-live="polite">
        {active ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-ink">{active.patient_full_name}</span>
            <span className="tabular text-xs text-ink-muted">{active.patient_mrn}</span>
            {active.reason && <span className="text-xs text-ink-secondary">{active.reason}</span>}
            <span className="tabular text-xs text-ink-muted">
              {formatMinutes(minutesInClinicDay(active.starts_at))}–
              {formatMinutes(minutesInClinicDay(active.starts_at) + active.duration_min)} · {active.duration_min} min
            </span>
            <span className="text-xs text-ink-muted">{active.lane}</span>
            <span className={`text-xs font-medium ${STATUS_STYLE[active.status].text}`}>
              {STATUS_STYLE[active.status].label}
            </span>
          </div>
        ) : (
          <span className="text-xs text-ink-muted">Hover or focus an appointment to see its detail.</span>
        )}
      </div>
    </div>
  );
}

export { STATUS_STYLE as APPOINTMENT_STATUS_STYLE };
