'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

export default function RegisterForm({ siteId }: { siteId: string }) {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [dob, setDob] = useState('');
  const [sex, setSex] = useState('F');
  const [phone, setPhone] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc('register_patient', {
      p_full_name: fullName,
      p_dob: dob || null,
      p_sex: sex,
      p_phone: phone || null,
      p_national_id: nationalId || null,
      p_site_id: siteId,
      p_chief_complaint: chiefComplaint || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    router.push(`/dashboard/triage/${row.encounter_id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input required placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
      <div className="flex gap-3">
        <input type="date" placeholder="Date of birth" value={dob} onChange={(e) => setDob(e.target.value)} className="flex-1 rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
        <select value={sex} onChange={(e) => setSex(e.target.value)} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent">
          <option value="F">F</option>
          <option value="M">M</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
      <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
      <input placeholder="National ID (optional)" value={nationalId} onChange={(e) => setNationalId(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
      <textarea placeholder="Reason for visit" value={chiefComplaint} onChange={(e) => setChiefComplaint(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" rows={2} />
      {error && <p className="text-alert text-sm">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-clinic text-white px-4 py-2 font-medium disabled:opacity-50">
        {busy ? 'Registering…' : 'Register & send to triage'}
      </button>
    </form>
  );
}
