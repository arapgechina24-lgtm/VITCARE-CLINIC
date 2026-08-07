import { Lock } from 'lucide-react';
import { roleLabel } from '@/lib/roles';

/**
 * Shown in place of a panel the caller's role may not see.
 *
 * The distinction this exists to preserve is the same one the allergy banner
 * makes: "there is nothing here" and "you are not allowed to see what is here"
 * are different facts, and rendering the second as the first is a lie the
 * reader will act on. A receptionist who sees an empty Prescriptions tab would
 * reasonably tell a patient they have no medicines waiting.
 *
 * It names the restriction and stops. It does not say how many records were
 * withheld, because a count is itself disclosure — "12 prescriptions hidden"
 * tells you the patient is on twelve drugs.
 */
export function RestrictedPanel({ what, role }: { what: string; role: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center">
      <Lock className="mx-auto mb-3 h-6 w-6 text-ink-muted" aria-hidden />
      <p className="text-sm font-medium text-ink">{what} are not visible to your role</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-ink-muted">
        Your account is a {roleLabel(role).toLowerCase()}. This part of the record is restricted to
        clinical staff — it was not sent to this page, not merely hidden on it. Ask a clinician if
        you need it for a patient in front of you.
      </p>
    </div>
  );
}
