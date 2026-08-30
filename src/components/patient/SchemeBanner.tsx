import { Building2, ShieldAlert, TriangleAlert } from 'lucide-react';
import {
  coverSummary,
  schemeMonthSummary,
  limitTone,
  type EncounterSchemeContext,
} from '@/lib/schemes';

/**
 * Who is paying for this visit, stated before anything is decided.
 *
 * Sits beside the allergy banner and follows the same rule: the fact that
 * changes what the reader does goes first, in words, never in colour alone.
 *
 * What it must NOT do is read like a barrier. The facility decided in 0030
 * that crossing a company's monthly limit warns and records — it never refuses
 * care — so an over-limit farm is rendered as information the clinician should
 * know, not as a stop sign over a patient. The one genuinely blocking state is
 * lapsed cover, and that is the desk's problem to fix, not the clinician's:
 * start_encounter refuses to attach a lapsed membership in the first place, so
 * this only appears if cover ended mid-visit.
 */
export function SchemeBanner({
  ctx,
  action,
}: {
  ctx: EncounterSchemeContext;
  /** The "post this visit" control, when the reader is allowed to post. */
  action?: React.ReactNode;
}) {
  const tone = limitTone({ cap_cents: ctx.cap_cents, spent_cents: ctx.spent_cents });

  const style = !ctx.covered
    ? { wrap: 'border-critical/40 bg-critical-wash', ink: 'text-critical-ink', Icon: ShieldAlert }
    : tone === 'over'
      ? { wrap: 'border-warning/50 bg-warning-wash', ink: 'text-warning-ink', Icon: TriangleAlert }
      : { wrap: 'border-clinic/30 bg-clinic/5', ink: 'text-clinic', Icon: Building2 };

  const { Icon } = style;
  const posted = ctx.charge_id !== null;

  return (
    <div
      role={ctx.covered ? 'status' : 'alert'}
      className={`rounded-xl border px-3 py-2.5 ${style.wrap}`}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.ink}`} aria-hidden />
        <p className={`text-2xs font-semibold uppercase tracking-wider ${style.ink}`}>
          On account
        </p>
        <p className={`flex-1 text-sm font-semibold ${style.ink}`}>{coverSummary(ctx)}</p>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      <p className="mt-1 pl-6 text-2xs text-ink-muted">
        {/* The company's month, not the patient's. Said explicitly, because a
            figure on a screen about one person is read as being about them. */}
        {ctx.scheme_code} this month: {schemeMonthSummary(ctx)}
        {ctx.household_size > 1 && ` · ${ctx.household_size} people on payroll ${ctx.employee_no}`}
      </p>

      {posted && (
        <p className="mt-1 pl-6 text-2xs text-ink-muted">
          {ctx.charge_status === 'STATEMENTED'
            ? 'Already on an issued statement — the figures are fixed.'
            : 'Posted to this month’s statement. Posting again re-prices it from what is recorded.'}
        </p>
      )}

      {/* No invoice will be raised for this visit, and the desk needs to know
          that rather than discover it as a refusal at the till. */}
      {!posted && ctx.covered && (
        <p className="mt-1 pl-6 text-2xs text-ink-muted">
          Billed to {ctx.scheme_name} on the monthly statement — not invoiced to the patient.
        </p>
      )}
    </div>
  );
}
