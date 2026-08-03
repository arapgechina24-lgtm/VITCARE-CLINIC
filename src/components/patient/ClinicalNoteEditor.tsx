'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';

/**
 * The doctor's note.
 *
 * Deliberately plain: a single autosizing textarea, no toolbar, no rich text.
 * A clinician writing under time pressure needs an empty page, not formatting
 * controls — and plain text is also what stays searchable and portable for the
 * lifetime of a medical record.
 *
 * A note attaches to a VISIT, not to a patient. That's a real clinical
 * constraint (a note has to be anchored to when it was made and what it was
 * about), so the editor only appears when there's an open encounter, and says
 * plainly why when there isn't — rather than silently rendering a box whose
 * save would fail.
 *
 * Saving is explicit. Autosave was considered and rejected: a half-typed
 * differential silently committed to a permanent medical record is worse than
 * one the clinician chose to save. Unsaved work is warned about on navigation
 * instead.
 */
export function ClinicalNoteEditor({
  encounterId,
  initialNote,
  canWrite,
  reason,
}: {
  encounterId: string | null;
  initialNote: string;
  canWrite: boolean;
  /** Why the editor is unavailable, when it is. */
  reason?: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = note !== initialNote;

  // Grow with the content — a scrollbar inside a note field hides what you
  // just wrote, which is exactly the wrong thing while composing.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 160)}px`;
  }, [note]);

  // Guard against losing unsaved clinical text to an accidental navigation.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!canWrite || !encounterId) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-surface-sunken px-4 py-6 text-center">
        <p className="text-sm text-ink-secondary">Clinical notes can&apos;t be added right now.</p>
        <p className="mt-1 text-xs text-ink-muted">
          {reason ?? 'A note has to attach to an open visit.'}
        </p>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    const { error } = await supabase.rpc('save_consult_notes', {
      p_encounter_id: encounterId,
      p_clinical_notes: note,
    });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSavedAt(new Date());
    // Refresh so the history tab reflects the saved note without a reload.
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          Consultation note
        </p>
        <p className="text-2xs text-ink-muted" aria-live="polite">
          {saving
            ? 'Saving…'
            : dirty
              ? 'Unsaved changes'
              : savedAt
                ? `Saved ${savedAt.toLocaleTimeString('en-KE', { timeStyle: 'short' })}`
                : ''}
        </p>
      </div>

      <textarea
        ref={areaRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Assessment, findings, plan…"
        aria-label="Consultation note"
        className="block w-full resize-none border-0 bg-transparent px-4 py-3.5 text-sm leading-relaxed text-ink placeholder:text-ink-muted focus:outline-none"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <p className="text-2xs text-ink-muted">
          Saved to this visit and visible to the care team. Recorded against your name.
        </p>
        <div className="flex items-center gap-2">
          {error && (
            <span className="flex items-center gap-1 text-2xs font-medium text-critical-ink">
              <TriangleAlert className="h-3 w-3" aria-hidden />
              {error}
            </span>
          )}
          <button
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            Save note
          </button>
        </div>
      </div>
    </div>
  );
}
