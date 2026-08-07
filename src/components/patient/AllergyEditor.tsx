'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, X } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import type { AllergyStatus, AllergySeverity, RecordedAllergy } from '@/lib/allergy-check';

interface Draft {
  key: string;
  substance: string;
  reaction: string;
  severity: '' | AllergySeverity;
}

const blank = (): Draft => ({ key: crypto.randomUUID(), substance: '', reaction: '', severity: '' });

/**
 * Recording an allergy history.
 *
 * The two answers are presented as an explicit either/or, and neither is
 * preselected. A default of "no known allergies" would be a system that asserts
 * a clinical fact nobody established; a default of "has allergies" would push
 * people to invent one. The clinician must choose, which is the same thing as
 * having actually asked.
 */
export function AllergyEditor({
  patientId,
  status,
  allergies,
  onClose,
}: {
  patientId: string;
  status: AllergyStatus;
  allergies: readonly RecordedAllergy[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<'' | 'NONE_KNOWN' | 'PRESENT'>(
    status === 'UNRECORDED' ? '' : status,
  );
  const [drafts, setDrafts] = useState<Draft[]>(
    allergies.length > 0
      ? allergies.map((a) => ({
          key: a.id ?? crypto.randomUUID(),
          substance: a.substance,
          reaction: a.reaction ?? '',
          severity: a.severity ?? '',
        }))
      : [blank()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = drafts.filter((d) => d.substance.trim().length > 0);
  const canSave = choice === 'NONE_KNOWN' || (choice === 'PRESENT' && filled.length > 0);

  function update(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('set_patient_allergies', {
      p_patient_id: patientId,
      p_status: choice,
      // The database rejects PRESENT with an empty list and a non-PRESENT
      // status with a non-empty one, so send exactly what the choice implies
      // rather than whatever happens to be typed in the boxes.
      p_allergies:
        choice === 'PRESENT'
          ? filled.map((d) => ({
              substance: d.substance.trim(),
              reaction: d.reaction.trim() || null,
              severity: d.severity || null,
            }))
          : [],
    });

    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    // Server components hold the record; refresh so the banner and the
    // prescribing gate both see the new state.
    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Record allergies"
        className="w-full max-w-lg rounded-2xl bg-surface p-5 shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-ink">Record allergies</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Ask the patient. Recording &ldquo;none known&rdquo; is a clinical finding in its own
              right — it is not the same as leaving this blank.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-surface-hover"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <fieldset className="mt-4">
          <legend className="sr-only">Allergy status</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['NONE_KNOWN', 'No known drug allergies', 'I asked; the patient reports none.'],
                ['PRESENT', 'Has drug allergies', 'List them below.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={`cursor-pointer rounded-xl border p-3 transition-colors ${
                  choice === value ? 'border-brand bg-brand-wash' : 'border-line hover:bg-surface-hover'
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="allergy-status"
                    value={value}
                    checked={choice === value}
                    onChange={() => setChoice(value)}
                  />
                  <span className="text-sm font-medium text-ink">{label}</span>
                </span>
                <span className="mt-0.5 block pl-6 text-xs text-ink-muted">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {choice === 'PRESENT' && (
          <div className="mt-4 space-y-2">
            {drafts.map((d) => (
              <div key={d.key} className="rounded-xl border border-line p-2.5">
                <div className="grid gap-2 sm:grid-cols-[1.2fr_1fr_auto]">
                  <label className="block">
                    <span className="sr-only">Substance</span>
                    <input
                      value={d.substance}
                      onChange={(e) => update(d.key, { substance: e.target.value })}
                      placeholder="Substance (e.g. Penicillin)"
                      className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="sr-only">Reaction</span>
                    <input
                      value={d.reaction}
                      onChange={(e) => update(d.key, { reaction: e.target.value })}
                      placeholder="Reaction (e.g. rash)"
                      className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
                    />
                  </label>
                  <div className="flex items-center gap-1">
                    <label className="block flex-1">
                      <span className="sr-only">Severity</span>
                      <select
                        value={d.severity}
                        onChange={(e) => update(d.key, { severity: e.target.value as Draft['severity'] })}
                        className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:border-brand focus:outline-none"
                      >
                        <option value="">Severity</option>
                        <option value="MILD">Mild</option>
                        <option value="MODERATE">Moderate</option>
                        <option value="SEVERE">Severe</option>
                      </select>
                    </label>
                    {drafts.length > 1 && (
                      <button
                        onClick={() => setDrafts((p) => p.filter((x) => x.key !== d.key))}
                        aria-label={`Remove ${d.substance || 'this allergy'}`}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-surface-hover hover:text-critical-ink"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={() => setDrafts((p) => [...p, blank()])}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add another
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-critical-ink">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink-secondary hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!canSave || busy}
            className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
