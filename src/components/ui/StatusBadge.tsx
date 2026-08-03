import type { LucideIcon } from 'lucide-react';
import { CheckCircle2, AlertTriangle, AlertOctagon, Clock, Circle } from 'lucide-react';

/**
 * Status indicator.
 *
 * NON-NEGOTIABLE: every status ships an ICON and a LABEL, never colour alone.
 * Two of the four status hues sit below 3:1 against a white surface (warning
 * 1.8:1, serious 2.6:1) — measured, not guessed — so colour cannot be the only
 * carrier of meaning. It also covers the ~1-in-12 men with colour-vision
 * deficiency, and printing, and glare on a clinic screen.
 *
 * Status colours are reserved. They never double as chart series colours.
 */
export type StatusTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

const TONE: Record<StatusTone, { icon: LucideIcon; wash: string; ink: string; dot: string }> = {
  good: { icon: CheckCircle2, wash: 'bg-good-wash', ink: 'text-good-ink', dot: 'bg-good' },
  warning: { icon: Clock, wash: 'bg-warning-wash', ink: 'text-warning-ink', dot: 'bg-warning' },
  serious: { icon: AlertTriangle, wash: 'bg-serious-wash', ink: 'text-serious-ink', dot: 'bg-serious' },
  critical: { icon: AlertOctagon, wash: 'bg-critical-wash', ink: 'text-critical-ink', dot: 'bg-critical' },
  neutral: { icon: Circle, wash: 'bg-surface-sunken', ink: 'text-ink-secondary', dot: 'bg-ink-muted' },
};

export function StatusBadge({
  tone,
  label,
  icon = true,
}: {
  tone: StatusTone;
  label: string;
  /** Only drop the icon where a coloured dot + text already carries it (dense tables). */
  icon?: boolean;
}) {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-2xs font-medium ${t.wash} ${t.ink}`}
    >
      {icon ? (
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden />
      )}
      {label}
    </span>
  );
}
