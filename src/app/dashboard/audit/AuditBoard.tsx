'use client';
import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import {
  RANGE_LABEL, auditContext, auditKind, auditRange, describeAuditEntry,
  type AuditEntry,
} from '@/lib/audit';
import { CLINIC_TZ } from '@/lib/appointments';

export interface FilterOptions {
  actors: Array<{ id: string; name: string }>;
  actions: string[];
  tables: string[];
}

type Preset = 'today' | '7d' | '30d' | 'all';

const TONE: Record<ReturnType<typeof auditKind>, StatusTone> = {
  read: 'neutral',
  write: 'warning',
  event: 'good',
};

/** Clinic time, explicitly — the same discipline as the schedule. A log read in
 *  Nairobi must not render timestamps in the reader's browser zone. */
function clinicTime(iso: string): string {
  return new Date(iso).toLocaleString('en-KE', {
    timeZone: CLINIC_TZ,
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

export function AuditBoard({
  initial, options, canSeeEverything,
}: {
  initial: AuditEntry[];
  options: FilterOptions;
  canSeeEverything: boolean;
}) {
  const [entries, setEntries] = useState(initial);
  const [preset, setPreset] = useState<Preset>('all');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hideReads, setHideReads] = useState(false);

  async function reload(next: Partial<{ preset: Preset; actor: string; action: string }> = {}) {
    const p = next.preset ?? preset;
    const a = next.actor ?? actor;
    const act = next.action ?? action;
    const range = auditRange(p);

    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc('list_audit_log', {
      p_from: range.from,
      p_to: range.to,
      p_actor_id: a || null,
      p_action: act || null,
      p_limit: 500,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setEntries((data ?? []) as AuditEntry[]);
  }

  // Reads dominate the log by an order of magnitude — 197 of the first 257
  // entries were record views. Hiding them is a lens, not a filter on the
  // server: the count below always states what is being hidden, so the screen
  // can never imply the log is shorter than it is.
  const shown = useMemo(
    () => (hideReads ? entries.filter((e) => auditKind(e.action) !== 'read') : entries),
    [entries, hideReads],
  );
  const hiddenCount = entries.length - shown.length;

  if (!canSeeEverything) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label>
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">Period</span>
          <select
            value={preset}
            onChange={(e) => { const v = e.target.value as Preset; setPreset(v); reload({ preset: v }); }}
            disabled={busy}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink disabled:opacity-40"
          >
            {(Object.keys(RANGE_LABEL) as Preset[]).map((k) => (
              <option key={k} value={k}>{RANGE_LABEL[k]}</option>
            ))}
          </select>
        </label>

        <label>
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">Who</span>
          <select
            value={actor}
            onChange={(e) => { setActor(e.target.value); reload({ actor: e.target.value }); }}
            disabled={busy}
            className="min-w-[160px] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink disabled:opacity-40"
          >
            <option value="">Anyone</option>
            {options.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>

        <label>
          <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">Action</span>
          <select
            value={action}
            onChange={(e) => { setAction(e.target.value); reload({ action: e.target.value }); }}
            disabled={busy}
            className="min-w-[140px] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink disabled:opacity-40"
          >
            <option value="">Everything</option>
            {options.actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>

        <label className="flex items-center gap-2 pb-2 text-xs text-ink-secondary">
          <input
            type="checkbox"
            checked={hideReads}
            onChange={(e) => setHideReads(e.target.checked)}
            className="h-4 w-4 rounded border-line"
          />
          Changes only
        </label>
      </div>

      {error && (
        <div className="rounded-lg bg-critical-wash px-3 py-2">
          <p className="text-xs text-critical-ink">{error}</p>
        </div>
      )}

      {hiddenCount > 0 && (
        <p className="text-2xs text-ink-muted">
          {hiddenCount} record view{hiddenCount === 1 ? '' : 's'} hidden by “Changes only”.
        </p>
      )}

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong py-10 text-center">
          <p className="text-sm text-ink-secondary">Nothing matches those filters.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((e) => {
            const context = auditContext(e);
            return (
              <li key={e.id} className="flex items-start gap-3 py-2.5">
                <span className="tabular w-[104px] shrink-0 text-2xs text-ink-muted">
                  {clinicTime(e.occurred_at)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{describeAuditEntry(e)}</span>
                  <span className="block truncate text-2xs text-ink-muted">
                    {e.actor_name ?? 'system'}
                    {e.actor_role ? ` · ${e.actor_role}` : ''}
                    {context ? ` · ${context}` : ''}
                  </span>
                  {e.patient_name && (
                    <span className="block truncate text-2xs text-ink-secondary">
                      Patient: {e.patient_name} <span className="tabular">{e.patient_mrn}</span>
                    </span>
                  )}
                </span>
                <StatusBadge tone={TONE[auditKind(e.action)]} label={e.action} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
