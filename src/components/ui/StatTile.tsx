import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Sparkline } from './Sparkline';

/**
 * Stat tile — the KPI unit.
 *
 * Contract: label (sentence case, no trailing colon) · value · optional delta
 * (signed, against a NAMED period) · optional 12-point trend.
 *
 * Two details that are easy to get wrong and are deliberate here:
 *
 * 1. The value uses PROPORTIONAL figures, not tabular. `tabular-nums` gives
 *    every digit the width of a zero, which makes a number like 121 look
 *    conspicuously loose at display sizes. Tabular is for columns that must
 *    align vertically — table rows, axis ticks — not for a standalone figure.
 *
 * 2. Delta colour encodes *direction × whether up is good*, which is not the
 *    same thing. Rising patient volume is neutral-to-good; rising pending
 *    pharmacy orders is bad. `higherIsBetter` makes each caller say which,
 *    instead of the component assuming green-means-up.
 */
export function StatTile({
  label,
  value,
  unit,
  icon: Icon,
  delta,
  deltaPeriod,
  higherIsBetter = true,
  trend,
  footnote,
  sample = false,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon?: LucideIcon;
  /** Signed percentage or absolute change. Omit when there's nothing to compare to. */
  delta?: number;
  /** Names the comparison period — a delta without one is meaningless. */
  deltaPeriod?: string;
  higherIsBetter?: boolean;
  trend?: number[];
  footnote?: string;
  /** Marks the whole tile as demo data. A real-looking figure with no real
   *  source behind it is the most dangerous thing on a clinical dashboard —
   *  so it gets a visible marker, not just a quiet footnote. */
  sample?: boolean;
}) {
  const hasDelta = typeof delta === 'number' && Number.isFinite(delta);
  const flat = hasDelta && delta === 0;
  const good = hasDelta && !flat && (delta > 0) === higherIsBetter;

  const DeltaIcon = flat ? Minus : (delta ?? 0) > 0 ? ArrowUpRight : ArrowDownRight;
  const deltaInk = flat ? 'text-ink-muted' : good ? 'text-good-ink' : 'text-critical-ink';

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="text-xs font-medium text-ink-secondary">{label}</p>
          {sample && (
            <span className="rounded bg-warning-wash px-1 py-0.5 text-2xs font-medium text-warning-ink">
              Sample
            </span>
          )}
        </div>
        {Icon && (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-wash text-brand-ink">
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
      </div>

      <div className="mt-2 flex items-end gap-1.5">
        <span className="text-3xl font-semibold leading-none tracking-tight text-ink">{value}</span>
        {unit && <span className="pb-0.5 text-sm font-medium text-ink-muted">{unit}</span>}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          {hasDelta ? (
            <p className={`flex items-center gap-1 text-2xs font-medium ${deltaInk}`}>
              <DeltaIcon className="h-3 w-3 shrink-0" aria-hidden />
              {/* Sign is written out as well as drawn — the arrow is not the
                  only carrier, for the same reason status never relies on hue. */}
              {delta > 0 ? '+' : ''}{delta}%
              {deltaPeriod && <span className="font-normal text-ink-muted">{deltaPeriod}</span>}
            </p>
          ) : (
            footnote && <p className="truncate text-2xs text-ink-muted">{footnote}</p>
          )}
        </div>
        {trend && trend.length > 1 && <Sparkline points={trend} />}
      </div>
    </div>
  );
}
