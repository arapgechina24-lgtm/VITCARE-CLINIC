'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import { AllergyBanner } from '@/components/patient/AllergyBanner';
import { AllergyEditor } from '@/components/patient/AllergyEditor';
import {
  checkDrug, evaluateGate, overrideNote,
  type AllergyStatus, type RecordedAllergy,
} from '@/lib/allergy-check';

interface ItemDraft {
  drugName: string;
  strength: string;
  dose: string;
  frequency: string;
  durationDays: string;
  quantity: string;
  instructions: string;
  substitutionAllowed: boolean;
  /** The prescriber has seen the allergy conflict and chosen to proceed. */
  allergyAcknowledged: boolean;
}

const BLANK_ITEM: ItemDraft = {
  drugName: '', strength: '', dose: '', frequency: '', durationDays: '', quantity: '1',
  instructions: '', substitutionAllowed: false, allergyAcknowledged: false,
};

export default function PrescribeForm({
  encounterId,
  patientId,
  sites,
  allergyStatus,
  allergies,
  allergiesReviewedAt,
}: {
  encounterId: string;
  patientId: string;
  sites: Array<{ id: string; name: string }>;
  allergyStatus: AllergyStatus;
  allergies: RecordedAllergy[];
  allergiesReviewedAt?: string | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ItemDraft[]>([{ ...BLANK_ITEM }]);
  const [fulfillmentSiteId, setFulfillmentSiteId] = useState(sites[0]?.id ?? '');
  const [payer, setPayer] = useState<'CASH' | 'SHA' | 'INSURER'>('CASH');
  const [insurerCode, setInsurerCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingAllergies, setEditingAllergies] = useState(false);

  // Recomputed as the clinician types, so the warning appears while the drug
  // name is still in front of them rather than on submit.
  const conflictsPerItem = useMemo(
    () => items.map((it) => checkDrug({ drugName: it.drugName }, allergies).conflicts),
    [items, allergies],
  );

  const gate = evaluateGate(
    allergyStatus,
    conflictsPerItem,
    items.map((it) => it.allergyAcknowledged),
  );

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) =>
      prev.map((it, idx) => {
        if (idx !== i) return it;
        const next = { ...it, ...patch };
        // Changing the drug invalidates the acknowledgement — it was given for
        // a different medicine, and carrying it over would silently approve one
        // the prescriber never saw a warning about.
        if (patch.drugName !== undefined && patch.drugName !== it.drugName) {
          next.allergyAcknowledged = false;
        }
        return next;
      }),
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fulfillmentSiteId) return setError('Select a pharmacy to fulfil this prescription.');
    if (gate.blocked) return setError(gate.reason);
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

    // Overrides travel with the prescription, so the dispensing pharmacist can
    // see the prescriber knew — rather than phoning the clinic to ask.
    const overrides = items
      .map((it, i) => (conflictsPerItem[i].length > 0 ? overrideNote(it.drugName, conflictsPerItem[i]) : null))
      .filter((n): n is string => n !== null);
    const fullNote = [note.trim(), ...overrides].filter(Boolean).join('\n');

    const { error: rpcError } = await supabase.rpc('submit_prescription', {
      p_encounter_id: encounterId,
      p_fulfillment_site_id: fulfillmentSiteId,
      p_payer: payer,
      p_insurer_code: payer === 'INSURER' ? insurerCode || null : null,
      p_note: fullNote || null,
      p_items: payload,
    });
    setBusy(false);
    if (rpcError) {
      // The database enforces the same rule independently; translate its code
      // rather than showing a raw Postgres message to a clinician.
      return setError(
        rpcError.message.includes('ALLERGIES_UNRECORDED')
          ? "This patient's allergies must be recorded before prescribing."
          : rpcError.message,
      );
    }
    router.push('/dashboard');
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <AllergyBanner
        status={allergyStatus}
        allergies={allergies}
        reviewedAt={allergiesReviewedAt}
        onRecord={
          <button
            type="button"
            onClick={() => setEditingAllergies(true)}
            className="rounded-lg border border-current px-2 py-1 text-xs font-medium"
          >
            {allergyStatus === 'UNRECORDED' ? 'Record now' : 'Update'}
          </button>
        }
      />

      {editingAllergies && (
        <AllergyEditor
          patientId={patientId}
          status={allergyStatus}
          allergies={allergies}
          onClose={() => setEditingAllergies(false)}
        />
      )}

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
        {items.map((it, i) => {
          const conflicts = conflictsPerItem[i];
          const unresolved = conflicts.length > 0 && !it.allergyAcknowledged;
          return (
            <div
              key={i}
              className={`rounded-lg border p-3 space-y-2 ${
                unresolved ? 'border-critical bg-critical-wash' : 'border-ink/10'
              }`}
            >
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

              {conflicts.length > 0 && (
                <div role="alert" className="rounded-lg border border-critical px-3 py-2 text-sm text-critical-ink">
                  <p className="flex items-start gap-1.5 font-semibold">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    Allergy conflict
                  </p>
                  <ul className="mt-1 space-y-0.5 pl-5">
                    {conflicts.map((c, ci) => (
                      <li key={ci}>{c.explanation}</li>
                    ))}
                  </ul>
                  <label className="mt-2 flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={it.allergyAcknowledged}
                      onChange={(e) => updateItem(i, { allergyAcknowledged: e.target.checked })}
                    />
                    Prescribe anyway — I have assessed the risk
                  </label>
                  <p className="mt-1 pl-6 text-xs opacity-80">
                    This will be recorded on the prescription and sent to the pharmacy.
                  </p>
                </div>
              )}

              {items.length > 1 && (
                <button type="button" onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))} className="text-sm text-alert underline">
                  Remove
                </button>
              )}
            </div>
          );
        })}
        <button type="button" onClick={() => setItems((prev) => [...prev, { ...BLANK_ITEM }])} className="text-sm text-clinic underline">
          + Add another drug
        </button>
      </div>

      <textarea placeholder="Note to pharmacist (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent" rows={2} />

      {/* States what the check did and did not cover. "No conflicts" from a
          heuristic over free text is not a safety guarantee, and presenting it
          as one is how a checker starts causing the harm it was built to stop. */}
      {allergyStatus !== 'UNRECORDED' && (
        <p className="text-xs text-ink-muted">
          {allergies.length > 0
            ? `Checked against ${allergies.length} recorded ${allergies.length === 1 ? 'allergy' : 'allergies'} by name and drug class.`
            : 'No allergies recorded for this patient.'}{' '}
          This check is a prompt, not a guarantee — it cannot know about brand names, excipients or
          classes it has not been taught. Your own review still governs.
        </p>
      )}

      {error && <p role="alert" className="text-alert text-sm">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || gate.blocked} className="rounded-lg bg-clinic text-white px-4 py-2 font-medium disabled:opacity-50">
          {busy ? 'Sending to pharmacy…' : 'Send to pharmacy'}
        </button>
        {gate.blocked && <span className="text-sm text-ink/60">{gate.reason}</span>}
      </div>
    </form>
  );
}
