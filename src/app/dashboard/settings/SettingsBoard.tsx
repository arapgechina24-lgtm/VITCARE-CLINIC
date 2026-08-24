'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ROLES, roleLabel } from '@/lib/roles';
import { moduleLabel } from '@/lib/catalogue';

export interface StaffRow {
  id: string;
  full_name: string;
  email: string | null;
  role: string;
  active: boolean;
  license_no: string | null;
  can_prescribe: boolean;
  site_count: number;
  last_sign_in_at: string | null;
  is_self: boolean;
}

export interface ModuleRow {
  module: string;
  services: number;
  active_services: number;
  billable_services: number;
  is_active: boolean;
}

export function SettingsBoard({
  staff, modules, siteId,
}: {
  staff: StaffRow[];
  modules: ModuleRow[];
  siteId: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** Every mutation: run it, show the server's message verbatim on failure,
   *  then refresh. The RPCs phrase their refusals as instructions ("ask another
   *  administrator"), so passing them straight through is right. */
  async function run(
    fn: () => PromiseLike<{ error: { message: string } | null }>,
    ok?: string,
  ) {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return setError(error.message);
    if (ok) setNote(ok);
    startTransition(() => router.refresh());
  }

  const neverSignedIn = staff.filter((s) => s.active && !s.last_sign_in_at);
  const unlicensed = staff.filter((s) => s.active && s.role === 'CLINICIAN' && !s.license_no);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg bg-critical-wash px-3 py-2">
          <p className="text-xs text-critical-ink">{error}</p>
        </div>
      )}
      {note && (
        <div className="rounded-lg bg-surface-sunken px-3 py-2">
          <p className="text-xs text-ink-secondary">{note}</p>
        </div>
      )}

      {/* The two facts an administrator most needs told, rather than left to
          notice: staff who cannot yet use the system, and prescribers whose
          prescriptions reach the pharmacy without a registration number. */}
      {(neverSignedIn.length > 0 || unlicensed.length > 0) && (
        <div className="space-y-1 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
          {neverSignedIn.length > 0 && (
            <p className="text-xs text-ink-secondary">
              <span className="font-medium text-ink">{neverSignedIn.length}</span> active
              {neverSignedIn.length === 1 ? ' account has' : ' accounts have'} never signed in:{' '}
              {neverSignedIn.map((s) => s.full_name).join(', ')}. They sign in at /login with their
              email — no password, the system sends a code.
            </p>
          )}
          {unlicensed.length > 0 && (
            <p className="text-xs text-ink-secondary">
              <span className="font-medium text-ink">{unlicensed.length}</span> clinician
              {unlicensed.length === 1 ? ' has' : 's have'} no practitioner licence recorded, so
              their prescriptions reach the pharmacy without a registration number.
            </p>
          )}
        </div>
      )}

      <ul className="divide-y divide-line">
        {staff.map((s) => (
          <StaffCard key={s.id} s={s} busy={busy} onRun={run} />
        ))}
      </ul>

      {siteId && modules.length > 0 && (
        <section className="border-t border-line pt-5">
          <h2 className="text-sm font-semibold text-ink">Service modules</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Switching a module on is a statement that its licence, equipment and registered
            personnel are in place — the system cannot check that, so it records who turned it on.
            Core cannot be switched off.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {modules.map((m) => (
              <li key={m.module} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{moduleLabel(m.module)}</span>
                  <span className="block text-2xs text-ink-muted">
                    {m.services} service{m.services === 1 ? '' : 's'}
                    {m.billable_services < m.services
                      ? ` · ${m.services - m.billable_services} never chargeable`
                      : ''}
                  </span>
                </span>
                <StatusBadge
                  tone={m.is_active ? 'good' : 'neutral'}
                  label={m.is_active ? 'Running' : 'Off'}
                />
                {m.module !== 'Core' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(
                      () => supabase.rpc('set_service_module_active', {
                        p_site_id: siteId, p_module: m.module, p_active: !m.is_active,
                      }),
                      `${moduleLabel(m.module)} ${m.is_active ? 'switched off' : 'switched on'}.`,
                    )}
                    className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface disabled:opacity-40"
                  >
                    {m.is_active ? 'Switch off' : 'Switch on'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StaffCard({
  s, busy, onRun,
}: {
  s: StaffRow;
  busy: boolean;
  onRun: (fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) => void;
}) {
  const [licence, setLicence] = useState(s.license_no ?? '');
  const dirty = licence.trim() !== (s.license_no ?? '');

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">
            {s.full_name}
            {s.is_self && <span className="ml-1.5 text-2xs font-normal text-ink-muted">(you)</span>}
          </span>
          <span className="block truncate text-2xs text-ink-muted">
            {s.email ?? 'no email'}
            {' · '}
            {s.last_sign_in_at
              ? `last signed in ${new Date(s.last_sign_in_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })}`
              : 'never signed in'}
            {s.site_count === 0 ? ' · no site' : ''}
          </span>
        </span>

        {s.can_prescribe && <StatusBadge tone="good" label="Can prescribe" />}
        <StatusBadge tone={s.active ? 'good' : 'neutral'} label={s.active ? 'Active' : 'Inactive'} />

        {/* Self-changes are refused by the server; disabling them here means an
            administrator is not invited to try. */}
        <select
          aria-label={`Role for ${s.full_name}`}
          value={s.role}
          disabled={busy || s.is_self}
          onChange={(e) => onRun(
            () => supabase.rpc('set_user_role', { p_user_id: s.id, p_role: e.target.value }),
            `${s.full_name} is now ${roleLabel(e.target.value)}.`,
          )}
          className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink disabled:opacity-40"
        >
          {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </select>

        <button
          type="button"
          disabled={busy || s.is_self}
          onClick={() => onRun(
            () => supabase.rpc('set_user_active', { p_user_id: s.id, p_active: !s.active }),
            `${s.full_name} ${s.active ? 'deactivated' : 'reactivated'}.`,
          )}
          className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-secondary hover:bg-surface disabled:opacity-40"
        >
          {s.active ? 'Deactivate' : 'Reactivate'}
        </button>
      </div>

      {/* Licence sits under the row because it is free text that needs saving,
          not a control that fires on change. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-0.5">
        <label className="flex items-center gap-2">
          <span className="text-2xs text-ink-muted">Practitioner licence</span>
          <input
            value={licence}
            onChange={(e) => setLicence(e.target.value)}
            placeholder="e.g. KMPDC-12345"
            className="w-44 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-muted"
          />
        </label>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => onRun(
            () => supabase.rpc('set_user_license', { p_user_id: s.id, p_license_no: licence }),
            licence.trim()
              ? `Licence recorded for ${s.full_name}.`
              : `Licence cleared for ${s.full_name}.`,
          )}
          className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-secondary hover:bg-surface disabled:opacity-40"
        >
          Save
        </button>
        {s.role === 'ADMIN' && !s.license_no && (
          <span className="text-2xs text-ink-muted">
            An administrator prescribes only while a licence is recorded.
          </span>
        )}
      </div>
    </li>
  );
}
