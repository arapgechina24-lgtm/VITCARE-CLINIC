'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

interface ItemDraft {
  drugName: string;
  strength: string;
  dose: string;
  frequency: string;
  durationDays: string;
  quantity: string;
  instructions: string;
  substitutionAllowed: boolean;
}

const BLANK_ITEM: ItemDraft = {
  drugName: '', strength: '', dose: '', frequency: '', durationDays: '', quantity: '1', instructions: '', substitutionAllowed: false,
};

export default function PrescribeForm({ encounterId, sites }: { encounterId: string; sites: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [items, setItems] = useState<ItemDraft[]>([{ ...BLANK_ITEM }]);
  const [fulfillmentSiteId, setFulfillmentSiteId] = useState(sites[0]?.id ?? '');
  const [payer, setPayer] = useState<'CASH' | 'SHA' | 'INSURER'>('CASH');
  const [insurerCode, setInsurerCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fulfillmentSiteId) return setError('Select a pharmacy to fulfil this prescription.');
    setBusy(true);
    setError(null);

    const payload = items.map((it) => ({
      drugName: it.drugName,
      strength: it.strength || undefined,
      dose: it.dose,
      frequency: it.frequency,
      durationDays: it.durationDays ? Number(it.durationDays) : undefined,
      quantity: Number(it.quantity),
      instructions: it.instructions || undefined,
      substitutionAllowed: it.substitutionAllowed,
    }));

    const { error } = await supabase.rpc('submit_prescription', {
      p_encounter_id: encounterId,
      p_fulfillment_site_id: fulfillmentSiteId,
      p_payer: payer,
      p_insurer_code: payer === 'INSURER' ? insurerCode || null : null,
      p_note: note || null,
      p_items: payload,
    });
    setBusy(false);
    if (error) return setError(error.message);
    router.push('/dashboard');
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-sm text-ink/60 mb-1">Fulfil at</label>
        <select value={fulfillmentSiteId} onChange={(e) => setFulfillmentSiteId(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent">
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="block text-sm text-ink/60 mb-1">Payer</label>
          <select value={payer} onChange={(e) => setPayer(e.target.value as typeof payer)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent">
            <option value="CASH">Cash</option>
            <option value="SHA">SHA</option>
            <option value="INSURER">Insurer</option>
          </select>
        </div>
        {payer === 'INSURER' && (
          <input placeholder="Insurer code" value={insurerCode} onChange={(e) => setInsurerCode(e.target.value)} className="flex-1 rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
        )}
      </div>

      <div className="space-y-3">
        <label className="block text-sm text-ink/60">Items</label>
        {items.map((it, i) => (
          <div key={i} className="rounded-lg border border-ink/10 p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input required placeholder="Drug name" value={it.drugName} onChange={(e) => updateItem(i, { drugName: e.target.value })} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
              <input placeholder="Strength (e.g. 500mg)" value={it.strength} onChange={(e) => updateItem(i, { strength: e.target.value })} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
              <input required placeholder="Dose (e.g. 1 tablet)" value={it.dose} onChange={(e) => updateItem(i, { dose: e.target.value })} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
              <input required placeholder="Frequency (e.g. TDS)" value={it.frequency} onChange={(e) => updateItem(i, { frequency: e.target.value })} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
              <input placeholder="Duration (days)" value={it.durationDays} onChange={(e) => updateItem(i, { durationDays: e.target.value })} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
              <input required type="number" min={1} placeholder="Quantity" value={it.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })} className="rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
            </div>
            <input placeholder="Instructions" value={it.instructions} onChange={(e) => updateItem(i, { instructions: e.target.value })} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" />
            <label className="flex items-center gap-2 text-sm text-ink/60">
              <input type="checkbox" checked={it.substitutionAllowed} onChange={(e) => updateItem(i, { substitutionAllowed: e.target.checked })} />
              Generic substitution allowed
            </label>
            {items.length > 1 && (
              <button type="button" onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))} className="text-sm text-alert underline">
                Remove
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => setItems((prev) => [...prev, { ...BLANK_ITEM }])} className="text-sm text-clinic underline">
          + Add another drug
        </button>
      </div>

      <textarea placeholder="Note to pharmacist (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" rows={2} />

      {error && <p className="text-alert text-sm">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-clinic text-white px-4 py-2 font-medium disabled:opacity-50">
        {busy ? 'Sending to pharmacy…' : 'Send to pharmacy'}
      </button>
    </form>
  );
}
