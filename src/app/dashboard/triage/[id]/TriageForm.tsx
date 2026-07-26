'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

export default function TriageForm({ encounterId, initialChiefComplaint }: { encounterId: string; initialChiefComplaint: string }) {
  const router = useRouter();
  const [chiefComplaint, setChiefComplaint] = useState(initialChiefComplaint);
  const [priority, setPriority] = useState('ROUTINE');
  const [temp, setTemp] = useState('');
  const [bp, setBp] = useState('');
  const [pulse, setPulse] = useState('');
  const [spo2, setSpo2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const vitals = { tempC: temp || null, bp: bp || null, pulseBpm: pulse || null, spo2Pct: spo2 || null };
    const { error } = await supabase.rpc('submit_triage', {
      p_encounter_id: encounterId,
      p_vitals: vitals,
      p_chief_complaint: chiefComplaint || null,
      p_priority: priority,
    });
    setBusy(false);
    if (error) return setError(error.message);
    router.push('/dashboard');
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <textarea placeholder="Chief complaint" value={chiefComplaint} onChange={(e) => setChiefComplaint(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" rows={2} />
      <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent">
        <option value="ROUTINE">Routine</option>
        <option value="URGENT">Urgent</option>
        <option value="EMERGENCY">Emergency</option>
      </select>
      <div className="grid grid-cols-2 gap-3">
        <input placeholder="Temp (°C)" value={temp} onChange={(e) => setTemp(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
        <input placeholder="BP (e.g. 120/80)" value={bp} onChange={(e) => setBp(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
        <input placeholder="Pulse (bpm)" value={pulse} onChange={(e) => setPulse(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
        <input placeholder="SpO2 (%)" value={spo2} onChange={(e) => setSpo2(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
      </div>
      {error && <p className="text-alert text-sm">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-clinic text-white px-4 py-2 font-medium disabled:opacity-50">
        {busy ? 'Saving…' : 'Send to consult'}
      </button>
    </form>
  );
}
