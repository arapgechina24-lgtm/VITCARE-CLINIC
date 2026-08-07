import { AlertTriangle, HelpCircle, ShieldCheck } from 'lucide-react';
import type { AllergyStatus, RecordedAllergy } from '@/lib/allergy-check';

/**
 * The allergy state, stated in words.
 *
 * The one job this component has is to keep "we asked and the answer was none"
 * visually and verbally distinct from "nobody has asked". Both are empty lists;
 * only one of them is reassurance. An EMR that renders them the same way turns
 * a blank field into a false negative, and a clinician reads a blank field as
 * permission to prescribe.
 *
 * Never colour alone: each state carries an icon and a sentence, because this
 * is read fast, on cheap monitors, by people who are tired.
 */
export function AllergyBanner({
  status,
  allergies,
  reviewedAt,
  reviewedBy,
  onRecord,
  compact,
}: {
  status: AllergyStatus;
  allergies: readonly RecordedAllergy[];
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  /** Rendered as a call to action when supplied. */
  onRecord?: React.ReactNode;
  compact?: boolean;
}) {
  const style =
    status === 'PRESENT'
      ? { wrap: 'border-critical/40 bg-critical-wash', ink: 'text-critical-ink', Icon: AlertTriangle }
      : status === 'UNRECORDED'
        ? { wrap: 'border-warning/50 bg-warning-wash', ink: 'text-warning-ink', Icon: HelpCircle }
        : { wrap: 'border-good/40 bg-good-wash', ink: 'text-good-ink', Icon: ShieldCheck };

  const { Icon } = style;

  return (
    <div
      // PRESENT is an alert: it must be announced when it appears, because a
      // clinician may be tabbing straight into the prescription fields.
      role={status === 'PRESENT' ? 'alert' : 'status'}
      className={`rounded-xl border px-3 ${compact ? 'py-2' : 'py-2.5'} ${style.wrap}`}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.ink}`} aria-hidden />
        <p className={`text-2xs font-semibold uppercase tracking-wider ${style.ink}`}>Allergies</p>

        {status === 'PRESENT' && (
          <p className={`flex-1 text-sm font-semibold ${style.ink}`}>
            {allergies.map((a, i) => (
              <span key={a.id ?? a.substance}>
                {i > 0 && <span className="font-normal opacity-60"> · </span>}
                <span className="uppercase">{a.substance}</span>
                {(a.reaction || a.severity) && (
                  <span className="font-normal opacity-80">
                    {' ('}
                    {[a.reaction, a.severity?.toLowerCase()].filter(Boolean).join(', ')}
                    {')'}
                  </span>
                )}
              </span>
            ))}
          </p>
        )}

        {status === 'NONE_KNOWN' && (
          <p className={`flex-1 text-sm font-medium ${style.ink}`}>No known drug allergies</p>
        )}

        {status === 'UNRECORDED' && (
          <p className={`flex-1 text-sm font-semibold ${style.ink}`}>
            Not recorded — ask the patient before prescribing
          </p>
        )}

        {onRecord && <div className="shrink-0">{onRecord}</div>}
      </div>

      {/* Who asked and when. A review from years ago is not the same fact as one
          taken this morning, and only the reader can decide if it is stale. */}
      {status !== 'UNRECORDED' && reviewedAt && !compact && (
        <p className="mt-1 pl-6 text-2xs text-ink-muted">
          Recorded {new Date(reviewedAt).toLocaleDateString('en-KE', { dateStyle: 'medium' })}
          {reviewedBy ? ` by ${reviewedBy}` : ''}
        </p>
      )}
    </div>
  );
}
