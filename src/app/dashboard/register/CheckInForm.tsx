'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, User } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import { formatKes } from '@/lib/billing';
import { memberRole, type Scheme, type SchemeMemberLookup } from '@/lib/schemes';

interface PatientHit {
  id: string;
  mrn: string;
  full_name: string;
  phone: string | null;
}

/**
 * Starting a visit for someone the clinic already knows.
 *
 * This existed nowhere. A visit could only begin by registering a NEW patient
 * or by arriving a booked appointment, so a returning walk-in had no correct
 * path at all — and every one of the farms' 1,191 members is, by definition,
 * already registered. Re-registering one would mint a duplicate record under a
 * fresh MRN, cut off from their history and from the scheme that pays for them.
 *
 * The scheme picker is the other half. Which company is paying decides whether
 * this visit ends on a monthly statement or on an invoice at the window, and
 * that is settled here, at the desk, by the person who can see the patient's
 * ID card — not inferred later from a name.
 */
export default function CheckInForm({
  siteId,
  schemes,
}: {
  siteId: string;
  schemes: Scheme[];
}) {
  const router = useRouter();
  // '' is the cash lane; a scheme id searches that farm's register instead.
  const [schemeId, setSchemeId] = useState('');
  const [query, setQuery] = useState('');
  const [patientHits, setPatientHits] = useState<PatientHit[]>([]);
  const [memberHits, setMemberHits] = useState<SchemeMemberLookup[]>([]);
  const [chosen, setChosen] = useState<
    { patientId: string; memberId: string | null; label: string } | null
  >(null);
  const [complaint, setComplaint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Debounced, and the state writes live inside the timer rather than in the
  // effect body — a synchronous setState in an effect is what broke CI on this
  // repo before, and it is the same bug every time.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      const t = setTimeout(() => {
        setPatientHits([]);
        setMemberHits([]);
      }, 0);
      return () => clearTimeout(t);
    }
    const timer = setTimeout(async () => {
      if (schemeId) {
        const { data } = await supabase.rpc('lookup_scheme_member', {
          p_scheme_id: schemeId,
          p_query: q,
        });
        setMemberHits(((data ?? []) as SchemeMemberLookup[]).slice(0, 8));
        setPatientHits([]);
      } else {
        const { data } = await supabase.rpc('list_patients', { p_site_id: siteId, p_search: q });
        setPatientHits(((data ?? []) as PatientHit[]).slice(0, 8));
        setMemberHits([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, schemeId, siteId]);

  async function start() {
    if (!chosen) return setError('Find the patient first.');
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc('start_encounter', {
      p_patient_id: chosen.patientId,
      p_chief_complaint: complaint.trim() || null,
      p_scheme_member_id: chosen.memberId,
    });
    setBusy(false);
    if (error) return setError(error.message);
    router.push(`/dashboard/triage/${data as string}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setSchemeId('');
            setChosen(null);
          }}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${
            schemeId === ''
              ? 'border-brand bg-brand/10 font-medium text-brand'
              : 'border-line text-ink-secondary hover:bg-surface'
          }`}
        >
          <User className="h-3.5 w-3.5" aria-hidden />
          Paying patient
        </button>
        {schemes
          .filter((s) => s.active)
          .map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSchemeId(s.id);
                setChosen(null);
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${
                schemeId === s.id
                  ? 'border-brand bg-brand/10 font-medium text-brand'
                  : 'border-line text-ink-secondary hover:bg-surface'
              }`}
            >
              <Building2 className="h-3.5 w-3.5" aria-hidden />
              {s.code}
            </button>
          ))}
      </div>

      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setChosen(null);
        }}
        placeholder={schemeId ? 'Payroll number, member number or name' : 'Name, MRN or phone'}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted"
      />

      {chosen ? (
        <div className="rounded-lg border border-brand/40 bg-brand/5 px-3 py-2">
          <p className="text-sm font-medium text-ink">{chosen.label}</p>
          <button
            type="button"
            onClick={() => setChosen(null)}
            className="mt-0.5 text-2xs text-ink-muted underline"
          >
            choose someone else
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line empty:hidden">
          {patientHits.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() =>
                  setChosen({
                    patientId: p.id,
                    memberId: null,
                    label: `${p.full_name} · ${p.mrn}`,
                  })
                }
                className="block w-full px-3 py-2 text-left hover:bg-surface"
              >
                <span className="text-sm text-ink">{p.full_name}</span>
                <span className="ml-2 text-2xs text-ink-muted">{p.mrn}</span>
              </button>
            </li>
          ))}
          {memberHits.map((m) => (
            <li key={m.member_id}>
              <button
                type="button"
                // Cover is checked by start_encounter against the day of the
                // visit and refused there; disabling the row here as well means
                // the desk is told before it types a complaint, not after.
                disabled={!m.covered}
                onClick={() =>
                  setChosen({
                    patientId: m.patient_id,
                    memberId: m.member_id,
                    label: `${m.full_name} · payroll ${m.employee_no} · ${memberRole(m)}`,
                  })
                }
                className="block w-full px-3 py-2 text-left hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="text-sm text-ink">{m.full_name}</span>
                <span className="ml-2 text-2xs text-ink-muted">
                  payroll {m.employee_no} · {memberRole(m)}
                  {m.household_size > 1 ? ` · ${m.household_size} on this account` : ''}
                  {m.month_spend_cents > 0
                    ? ` · ${formatKes(m.month_spend_cents)} this month`
                    : ''}
                </span>
                {!m.covered && (
                  <span className="ml-2 text-2xs font-semibold text-critical-ink">
                    cover ended — start as a paying patient
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={complaint}
        onChange={(e) => setComplaint(e.target.value)}
        placeholder="Reason for visit"
        rows={2}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted"
      />

      {error && <p className="text-sm text-critical-ink">{error}</p>}

      <button
        type="button"
        disabled={busy || !chosen}
        onClick={start}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40"
      >
        {busy ? 'Starting…' : 'Start visit & send to triage'}
      </button>
    </div>
  );
}
