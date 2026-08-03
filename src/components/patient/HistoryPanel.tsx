import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import type { RecordEncounter } from '@/lib/patient-record';

/**
 * Medical history — every visit as a vertical timeline, newest first.
 *
 * A timeline rather than a table because the clinically useful question is
 * "what happened, in what order" rather than "compare these columns". The
 * clinical note is shown in full: truncating a doctor's assessment behind a
 * "read more" is how the important sentence gets missed.
 */

const PRIORITY_TONE: Record<string, StatusTone> = {
  EMERGENCY: 'critical',
  URGENT: 'serious',
  ROUTINE: 'neutral',
};

const STATUS_TONE: Record<string, StatusTone> = {
  COMPLETED: 'good',
  IN_CONSULT: 'warning',
  TRIAGE: 'warning',
  CANCELLED: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  IN_CONSULT: 'In consult',
  TRIAGE: 'Awaiting triage',
  CANCELLED: 'Cancelled',
};

export function HistoryPanel({ encounters }: { encounters: RecordEncounter[] }) {
  if (encounters.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-muted">
        No visits recorded for this patient yet.
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 border-l border-line pl-6">
      {encounters.map((e) => (
        <li key={e.id} className="relative">
          {/* Timeline node, centred on the rail. */}
          <span
            className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-line-strong"
            aria-hidden
          />
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {e.chief_complaint || 'Visit'}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {new Date(e.created_at).toLocaleString('en-KE', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                  {e.clinician ? ` · ${e.clinician}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {e.triage_priority && (
                  <StatusBadge tone={PRIORITY_TONE[e.triage_priority] ?? 'neutral'} label={e.triage_priority} />
                )}
                <StatusBadge
                  tone={STATUS_TONE[e.status] ?? 'neutral'}
                  label={STATUS_LABEL[e.status] ?? e.status}
                />
              </div>
            </div>

            {e.clinical_notes ? (
              <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2.5">
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                  Clinical note
                </p>
                {/* whitespace-pre-wrap: doctors write in paragraphs and lists,
                    and collapsing their line breaks changes how a note reads. */}
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">
                  {e.clinical_notes}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs italic text-ink-muted">No clinical note recorded for this visit.</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
