'use client';
import { useState } from 'react';
import type { MockClinician } from '@/lib/mock';
import { DAY_START_MIN, DAY_END_MIN } from '@/lib/mock';

/**
 * The day's clinicians as a horizontal timeline — one row per clinician.
 *
 * A deliberate design decision: appointment blocks are ALL one hue, not
 * coloured per clinician. Each clinician already has their own labelled row,
 * so colouring by clinician would be redundant encoding — it adds visual noise
 * without adding information, and it would burn a categorical palette on
 * something the layout already says. Colour here is reserved for *state*
 * (in progress, checked in), which the row layout cannot express.
 *
 * Status is carried by fill + a text label inside the block, never by hue
 * alone, so it survives colour-vision deficiency and greyscale printing.
 */

const STATUS_STYLE: Record<
  MockClinician['appointments'][number]['status'],
  { block: string; label: string; text: string }
> = {
  done: { block: 'bg-surface-sunken border-line', label: 'Done', text: 'text-ink-muted' },
  'in-progress': { block: 'bg-brand-wash-strong border-brand/30', label: 'In progress', text: 'text-brand-ink' },
  'checked-in': { block: 'bg-warning-wash border-warning/30', label: 'Checked in', text: 'text-warning-ink' },
  scheduled: { block: 'bg-surface border-line-strong border-dashed', label: 'Scheduled', text: 'text-ink-secondary' },
};

const HOURS = Array.from(
  { length: Math.floor((DAY_END_MIN - DAY_START_MIN) / 60) + 1 },
  (_, i) => DAY_START_MIN + i * 60,
);

const fmt = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
};

const pct = (min: number) => ((min - DAY_START_MIN) / (DAY_END_MIN - DAY_START_MIN)) * 100;

export function DaySchedule({ clinicians }: { clinicians: MockClinician[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  // Detail for the hovered/focused block is shown in a fixed strip BELOW the
  // timeline rather than in a floating tooltip. The timeline scrolls
  // horizontally, and a scroll container clips on both axes — CSS can't do
  // `overflow-x: auto; overflow-y: visible` — so an anchored tooltip was
  // getting cut off by the container edge. A stable strip also reads better on
  // a clinic screen (the detail is always in the same place instead of chasing
  // the cursor), and works for touch and keyboard focus, which tooltips don't.
  const active = clinicians
    .flatMap((c) => c.appointments.map((a) => ({ ...a, clinician: c.name })))
    .find((a) => a.id === hovered);

  // "Now" marker, only drawn when the clinic day is actually in progress —
  // a now-line pinned to an edge at 6am is worse than no line at all.
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowVisible = nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN;

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
              {fmt(h)}
            </span>
          ))}
        </div>

        <div className="space-y-2">
          {clinicians.map((c) => (
            <div key={c.id} className="flex items-stretch gap-3">
              {/* Row label — this is what carries clinician identity, not colour. */}
              <div className="w-[156px] shrink-0 py-1">
                <p className="truncate text-xs font-medium text-ink">{c.name}</p>
                <p className="truncate text-2xs text-ink-muted">{c.speciality}</p>
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
                    style={{ left: `${pct(nowMin)}%` }}
                    aria-hidden
                  />
                )}

                {c.appointments.map((a) => {
                  const s = STATUS_STYLE[a.status];
                  const left = pct(a.startMin);
                  const width = (a.durationMin / (DAY_END_MIN - DAY_START_MIN)) * 100;
                  // A 30-minute block is ~50px wide on a desktop row — enough
                  // for a truncated name and nothing else. Cramming the status
                  // in too produced "Ma… / Done", which tells you neither. Short
                  // blocks show the name alone; the tooltip carries the rest.
                  const roomy = a.durationMin >= 45;
                  return (
                    <button
                      key={a.id}
                      onMouseEnter={() => setHovered(a.id)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(a.id)}
                      onBlur={() => setHovered(null)}
                      // Inset by 1px each side so adjacent blocks show a surface
                      // gap rather than fusing into one bar.
                      className={`group absolute top-1.5 bottom-1.5 rounded-md border px-2 text-left transition-shadow hover:shadow-md ${s.block} ${
                        roomy ? '' : 'flex items-center'
                      }`}
                      style={{ left: `calc(${left}% + 1px)`, width: `calc(${width}% - 2px)` }}
                      aria-label={`${a.patientName}, ${a.reason}, ${fmt(a.startMin)} for ${a.durationMin} minutes, ${s.label}`}
                    >
                      <span className="block w-full overflow-hidden">
                        <span className={`block truncate text-2xs font-medium ${s.text}`}>{a.patientName}</span>
                        {roomy && <span className="block truncate text-2xs text-ink-muted">{s.label}</span>}
                      </span>

                      {hovered === a.id && (
                        <span className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-brand/40" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Legend — always present, because these four states are colour-coded
            and identity must never be colour-alone. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
          {(Object.keys(STATUS_STYLE) as Array<keyof typeof STATUS_STYLE>).map((k) => (
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
            <span className="text-sm font-medium text-ink">{active.patientName}</span>
            <span className="text-xs text-ink-secondary">{active.reason}</span>
            <span className="tabular text-xs text-ink-muted">
              {fmt(active.startMin)}–{fmt(active.startMin + active.durationMin)} · {active.durationMin} min
            </span>
            <span className="text-xs text-ink-muted">{active.clinician}</span>
            <span className={`text-xs font-medium ${STATUS_STYLE[active.status].text}`}>
              {STATUS_STYLE[active.status].label}
            </span>
          </div>
        ) : (
          <span className="text-xs text-ink-muted">
            Hover or focus an appointment to see its detail.
          </span>
        )}
      </div>
    </div>
  );
}
