'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { formatKes } from '@/lib/billing';
import { clinicDateKey } from '@/lib/appointments';
import {
  SECTIONS, SECTION_HINT, noteIsEmpty, parseNote, serializeNote,
  type ConsultNote,
} from '@/lib/consult-note';
import {
  chargeBlockReason, groupByCategory, searchServices,
  type CatalogueService,
} from '@/lib/catalogue';

export interface RecordedService {
  id: string;
  service_id: string;
  code: string;
  name: string;
  unit: string | null;
  quantity: number;
  note: string | null;
  recorded_by_name: string | null;
  billable: boolean;
  billing_notes: string | null;
  cash_price_cents: number;
  billed: boolean;
}

/**
 * The consultation: what was found, and what was done.
 *
 * The second half is the one that did not exist before. A clinician records the
 * services performed here, against the catalogue, and the desk pulls that list
 * onto the invoice — so nobody reconstructs a visit from memory at the till.
 * Recording is NOT billing: this screen never prices anything onto a document,
 * and it deliberately accepts services that must never be charged, because
 * SHA capitation is paid on reported volume and an unrecorded immunisation is
 * money the facility has already earned and will not be paid for.
 */
export default function ConsultForm({
  encounterId,
  initialNotes,
  services,
  initialRecorded,
  canRecordServices,
}: {
  encounterId: string;
  initialNotes: string;
  services: CatalogueService[];
  initialRecorded: RecordedService[];
  canRecordServices: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState<ConsultNote>(() => parseNote(initialNotes));
  const [recorded, setRecorded] = useState(initialRecorded);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshRecorded() {
    const { data } = await supabase.rpc('list_encounter_services', { p_encounter_id: encounterId });
    setRecorded((data ?? []) as RecordedService[]);
  }

  async function save(then: 'stay' | 'prescribe') {
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('save_consult_notes', {
      p_encounter_id: encounterId,
      p_clinical_notes: serializeNote(note),
    });
    setBusy(false);
    if (error) return setError(error.message);
    if (then === 'prescribe') router.push(`/dashboard/prescribe/${encounterId}`);
    else router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg bg-critical-wash px-3 py-2">
          <p className="text-xs text-critical-ink">{error}</p>
        </div>
      )}

      <section className="space-y-3">
        {SECTIONS.map((s) => (
          <label key={s} className="block">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">{s}</span>
            <textarea
              value={note[s]}
              onChange={(e) => setNote({ ...note, [s]: e.target.value })}
              placeholder={SECTION_HINT[s]}
              rows={s === 'Assessment' || s === 'Plan' ? 4 : 3}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted"
            />
          </label>
        ))}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || noteIsEmpty(note)}
            onClick={() => save('stay')}
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink-secondary hover:bg-surface disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save note'}
          </button>
          <button
            type="button"
            disabled={busy || noteIsEmpty(note)}
            onClick={() => save('prescribe')}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40"
          >
            Save and prescribe
          </button>
        </div>
      </section>

      <ServicesPerformed
        encounterId={encounterId}
        services={services}
        recorded={recorded}
        readOnly={!canRecordServices}
        onChanged={refreshRecorded}
        onError={setError}
      />
    </div>
  );
}

function ServicesPerformed({
  encounterId, services, recorded, readOnly, onChanged, onError,
}: {
  encounterId: string;
  services: CatalogueService[];
  recorded: RecordedService[];
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const today = useMemo(() => clinicDateKey(), []);
  const alreadyRecorded = useMemo(
    () => new Set(recorded.map((r) => r.service_id)),
    [recorded],
  );

  // Only show the picker once someone is looking for something. A 202-line
  // list open by default is noise on a screen a clinician uses every visit.
  const matches = useMemo(() => {
    if (query.trim() === '') return [];
    return groupByCategory(
      searchServices(services, query).filter((s) => !alreadyRecorded.has(s.id)).slice(0, 40),
    );
  }, [services, query, alreadyRecorded]);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    onError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return onError(error.message);
    await onChanged();
  }

  return (
    <section className="border-t border-line pt-5">
      <h2 className="text-sm font-semibold text-ink">Services performed</h2>
      <p className="mt-0.5 text-xs text-ink-muted">
        Record what was actually done at this visit. The desk bills from this list, so
        anything left off is not charged — and anything the facility must not charge for
        still belongs here, because it is reported to SHA.
      </p>

      {recorded.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {recorded.map((r) => (
            <li key={r.id} className="flex items-start gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink">
                  {r.name}
                  {r.quantity > 1 && (
                    <span className="text-ink-secondary">
                      {' '}× {r.quantity}{r.unit ? ` ${r.unit.replace(/^Per /, '')}` : ''}
                    </span>
                  )}
                </span>
                <span className="block text-2xs text-ink-muted tabular">
                  {r.code}
                  {r.note ? ` · ${r.note}` : ''}
                  {r.recorded_by_name ? ` · ${r.recorded_by_name}` : ''}
                </span>
                {!r.billable && (
                  <span className="mt-0.5 block text-2xs text-ink-secondary">
                    Not charged — {r.billing_notes ?? 'statutory or programme-funded'}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right">
                <span className="tabular block text-xs text-ink-secondary">
                  {r.billable ? formatKes(r.cash_price_cents * r.quantity) : '—'}
                </span>
                <span className="block text-2xs text-ink-muted">
                  {r.billed ? 'on the invoice' : 'not yet billed'}
                </span>
              </span>
              {!readOnly && !r.billed && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() =>
                    supabase.rpc('remove_encounter_service', { p_id: r.id }))}
                  className="shrink-0 text-2xs text-ink-muted underline hover:text-critical-ink disabled:opacity-40"
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? (
        recorded.length === 0 && (
          <p className="mt-3 text-xs text-ink-muted">Nothing recorded for this visit yet.</p>
        )
      ) : (
        <div className="mt-3">
          <input
            aria-label="Find a service"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a service — dressing, urine culture, LAB-MIC-005…"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted"
          />

          {query.trim() !== '' && matches.length === 0 && (
            <p className="mt-2 text-xs text-ink-muted">
              Nothing matches “{query}”.
            </p>
          )}

          {matches.map(([category, rows]) => (
            <div key={category} className="mt-3">
              <p className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
                {category}
              </p>
              <ul className="mt-1 divide-y divide-line">
                {rows.map((s) => {
                  // Capture accepts non-billable services on purpose; only the
                  // price shown alongside changes. An inactive module is the
                  // one thing record_encounter_service refuses, because a
                  // service the facility cannot deliver cannot have happened.
                  const blocked = chargeBlockReason(s, today);
                  return (
                    <li key={s.id} className="flex items-center gap-3 py-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(() =>
                          supabase.rpc('record_encounter_service', {
                            p_encounter_id: encounterId,
                            p_service_id: s.id,
                            p_quantity: 1,
                            p_note: null,
                          }))}
                        className="min-w-0 flex-1 text-left disabled:opacity-40"
                      >
                        <span className="block truncate text-sm text-ink">{s.name}</span>
                        <span className="block truncate text-2xs text-ink-muted tabular">
                          {s.code}{s.unit ? ` · ${s.unit}` : ''}
                          {blocked ? ` · ${blocked}` : ''}
                        </span>
                      </button>
                      <span className="tabular shrink-0 text-xs text-ink-secondary">
                        {s.billable ? formatKes(s.cash_price_cents) : 'no charge'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
