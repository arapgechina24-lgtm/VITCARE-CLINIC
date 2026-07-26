'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

export default function ConsultForm({ encounterId, initialNotes }: { encounterId: string; initialNotes: string }) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('save_consult_notes', { p_encounter_id: encounterId, p_clinical_notes: notes });
    setBusy(false);
    if (error) return setError(error.message);
    router.push(`/dashboard/prescribe/${encounterId}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <textarea
        placeholder="Assessment / diagnosis"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent"
        rows={5}
        required
      />
      {error && <p className="text-alert text-sm">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-clinic text-white px-4 py-2 font-medium disabled:opacity-50">
        {busy ? 'Saving…' : 'Continue to prescribe'}
      </button>
    </form>
  );
}
