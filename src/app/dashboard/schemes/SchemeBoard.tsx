'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import {
  AlertTriangle, CalendarRange, Check, Download, FileSpreadsheet, FileText,
  Loader2, Search, UserPlus, Users2, X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import { formatKes, parseKesToCents } from '@/lib/billing';
import { Card, CardBody, CardHeader, CardSection } from '@/components/ui/Card';
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import {
  EMPLOYMENT_LABEL, LIMIT_TONE_LABEL, STATEMENT_STATUS_LABEL,
  canIssueStatement, dayLabel, limitTone, memberRole, periodEnd, periodLabel,
  periodOf, recentPeriods, usedPercent, usedPercentExact, weekOf,
  type EmploymentType, type Relation, type Scheme, type SchemeCharge,
  type SchemeMember, type SchemeMemberLookup, type SchemeStatement,
  type SchemeUtilisation,
} from '@/lib/schemes';

type Tab = 'today' | 'register' | 'members' | 'statements';

interface Awaiting {
  scheme_id: string; code: string; name: string; period: string;
  visits: number; total_cents: number;
  statement_id: string | null; statement_status: string | null;
}

/** Nairobi's calendar day. `new Date().toISOString()` is UTC, which is three
 *  hours behind the clinic and files an early-morning visit into yesterday. */
function nairobiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const TONE_FOR_LIMIT: Record<string, StatusTone> = {
  none: 'neutral', ok: 'good', warn: 'warning', over: 'critical',
};

const BAR_FOR_LIMIT: Record<string, string> = {
  none: 'bg-ink-muted', ok: 'bg-good', warn: 'bg-warning', over: 'bg-critical',
};

export function SchemeBoard({
  role, siteId, schemes, utilisation, statements, awaiting,
}: {
  role: string;
  siteId: string;
  schemes: Scheme[];
  utilisation: SchemeUtilisation[];
  statements: SchemeStatement[];
  awaiting: Awaiting[];
}) {
  const [, startTransition] = useTransition();

  const today = useMemo(() => nairobiToday(), []);
  const [schemeId, setSchemeId] = useState(schemes[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('today');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Live copies, so a posted charge updates the tracker without a page reload.
  const [util, setUtil] = useState(utilisation);
  const [stmts, setStmts] = useState(statements);
  const [pending, setPending] = useState(awaiting);

  const scheme = schemes.find((s) => s.id === schemeId);
  const current = util.find((u) => u.scheme_id === schemeId);

  const canPost = ['ADMIN', 'RECEPTIONIST'].includes(role);
  const canEnrol = canPost;
  const canSetLimit = role === 'ADMIN';
  const canIssue = role === 'ADMIN';

  const refresh = useCallback(async () => {
    const [{ data: u }, { data: s }, { data: p }] = await Promise.all([
      supabase.rpc('scheme_utilisation', { p_site_id: siteId }),
      supabase.rpc('list_scheme_statements', { p_site_id: siteId, p_limit: 24 }),
      supabase.rpc('scheme_periods_awaiting_statement', { p_site_id: siteId }),
    ]);
    if (u) setUtil(u as SchemeUtilisation[]);
    if (s) setStmts(s as SchemeStatement[]);
    if (p) setPending(p as Awaiting[]);
  }, [siteId]);

  if (!schemes.length) {
    return (
      <Card>
        <CardBody className="pt-5">
          <StatusBadge
            tone="neutral"
            label="No corporate scheme is set up for this site yet. An administrator can add one from Settings."
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Scheme picker + live tracker ─────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        {util.map((u) => {
          const tone = limitTone(u);
          const pct = usedPercent(u);
          const exact = usedPercentExact(u);
          const selected = u.scheme_id === schemeId;
          return (
            <button
              key={u.scheme_id}
              type="button"
              onClick={() => setSchemeId(u.scheme_id)}
              aria-pressed={selected}
              className={`rounded-xl border p-4 text-left shadow-sm transition ${
                selected ? 'border-brand bg-brand-wash/40' : 'border-line bg-surface hover:border-ink-muted'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{u.name}</p>
                  <p className="text-2xs text-ink-muted">
                    {u.code} · {periodLabel(u.period)} · {u.visits} visit{u.visits === 1 ? '' : 's'}
                    {u.members > 0 && ` · ${u.members} people`}
                  </p>
                </div>
                <StatusBadge tone={TONE_FOR_LIMIT[tone]} label={LIMIT_TONE_LABEL[tone]} />
              </div>

              <p className="mt-3 text-lg font-semibold tracking-tight text-ink">
                {formatKes(u.spent_cents)}
                {u.cap_cents !== null && (
                  <span className="ml-1 text-xs font-normal text-ink-muted">
                    of {formatKes(u.cap_cents)}
                  </span>
                )}
              </p>

              {pct !== null ? (
                <>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className={`h-full rounded-full ${BAR_FOR_LIMIT[tone]}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-2xs text-ink-muted">
                    {exact}% used ·{' '}
                    {u.remaining_cents !== null && u.remaining_cents >= 0
                      ? `${formatKes(u.remaining_cents)} left`
                      : `${formatKes(Math.abs(u.remaining_cents ?? 0))} over`}
                  </p>
                </>
              ) : (
                // Said in words rather than shown as an empty bar. "No limit
                // agreed" and "limit of zero" are different facts.
                <p className="mt-2 text-2xs text-ink-muted">
                  No monthly limit agreed yet — nothing is being flagged.
                </p>
              )}

              {u.over_limit_visits > 0 && (
                <p className="mt-1.5 flex items-center gap-1 text-2xs text-critical-ink">
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  {formatKes(u.over_limit_cents)} across {u.over_limit_visits} visit
                  {u.over_limit_visits === 1 ? '' : 's'} needs the company&rsquo;s approval
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-2 text-2xs text-ink-muted">
                <span>Consultation {formatKes(u.consultation_cents, { symbol: false })}</span>
                <span aria-hidden>·</span>
                <span>Lab {formatKes(u.lab_cents, { symbol: false })}</span>
                <span aria-hidden>·</span>
                <span>Surgical {formatKes(u.surgical_cents, { symbol: false })}</span>
                <span aria-hidden>·</span>
                <span>Pharmacy {formatKes(u.pharmacy_cents, { symbol: false })}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Months waiting to be invoiced ────────────────────────────── */}
      {pending.length > 0 && (
        <Card>
          <CardHeader
            title="Ready to invoice"
            subtitle="Months that are over and have visits on them but no issued statement."
          />
          <CardBody className="pt-0">
            <ul className="divide-y divide-line">
              {pending.map((p) => (
                <li key={`${p.scheme_id}-${p.period}`} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {p.name} — {periodLabel(p.period)}
                    </p>
                    <p className="text-2xs text-ink-muted">
                      {p.visits} visit{p.visits === 1 ? '' : 's'} · {formatKes(p.total_cents)}
                      {p.statement_status === 'DRAFT' && ' · draft prepared'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <DownloadButtons schemeId={p.scheme_id} period={p.period} />
                    <button
                      type="button"
                      disabled={busy || !canPost}
                      onClick={async () => {
                        setBusy(true); setError(null); setNotice(null);
                        const { error: e } = await supabase.rpc('build_scheme_statement', {
                          p_scheme_id: p.scheme_id, p_period: p.period,
                        });
                        if (e) setError(e.message);
                        else { setNotice(`${periodLabel(p.period)} statement prepared for ${p.name}.`); await refresh(); }
                        setBusy(false);
                      }}
                      className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
                    >
                      Prepare statement
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {(error || notice) && (
        <div>
          {error && <StatusBadge tone="critical" label={error} />}
          {notice && !error && <StatusBadge tone="good" label={notice} />}
        </div>
      )}

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1 border-b border-line">
        {([
          ['today', 'Record a visit'],
          ['register', 'Visit register'],
          ['members', 'Staff & dependants'],
          ['statements', 'Statements & limit'],
        ] as Array<[Tab, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === id
                ? 'border-brand text-brand-ink'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {scheme && tab === 'today' && (
        <PostVisit
          scheme={scheme}
          today={today}
          canPost={canPost}
          onPosted={async (msg) => { setNotice(msg); setError(null); await refresh(); startTransition(() => {}); }}
        />
      )}

      {scheme && tab === 'register' && <VisitRegister scheme={scheme} today={today} role={role} />}

      {scheme && tab === 'members' && (
        <MemberRegister scheme={scheme} canEnrol={canEnrol} today={today} />
      )}

      {scheme && tab === 'statements' && (
        <Statements
          scheme={scheme}
          statements={stmts.filter((s) => s.scheme_id === scheme.id)}
          current={current}
          today={today}
          canIssue={canIssue}
          canSetLimit={canSetLimit}
          onChanged={async (msg) => { setNotice(msg); setError(null); await refresh(); }}
          onError={(msg) => { setError(msg); setNotice(null); }}
        />
      )}
    </div>
  );
}

// ── Downloads ──────────────────────────────────────────────────────────
/**
 * Plain links, not fetch-and-blob.
 *
 * The route sets Content-Disposition, so the browser saves the file with the
 * right name and never has to hold a whole month in memory. It also means the
 * download works with the middle-click and "save link as" that a finance
 * office will inevitably use.
 */
function DownloadButtons({
  schemeId, period, from, to, compact = true,
}: {
  schemeId: string;
  period?: string;
  from?: string;
  to?: string;
  compact?: boolean;
}) {
  const query = period
    ? `scheme=${schemeId}&period=${period}`
    : `scheme=${schemeId}&from=${from}&to=${to}`;
  const cls = compact
    ? 'inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-sunken'
    : 'inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-surface-sunken';
  return (
    <>
      <a href={`/api/schemes/export?${query}&format=xlsx`} className={cls}>
        <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />
        Excel
      </a>
      <a href={`/api/schemes/export?${query}&format=pdf`} className={cls}>
        <FileText className="h-3.5 w-3.5" aria-hidden />
        PDF
      </a>
    </>
  );
}

// ── Record a visit ─────────────────────────────────────────────────────
function PostVisit({
  scheme, today, canPost, onPosted,
}: {
  scheme: Scheme;
  today: string;
  canPost: boolean;
  onPosted: (msg: string) => void | Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SchemeMemberLookup[]>([]);
  const [member, setMember] = useState<SchemeMemberLookup | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  const [date, setDate] = useState(today);
  const [consult, setConsult] = useState('');
  const [labDesc, setLabDesc] = useState('');
  const [labAmt, setLabAmt] = useState('');
  const [surgDesc, setSurgDesc] = useState('');
  const [surgAmt, setSurgAmt] = useState('');
  const [pharmDesc, setPharmDesc] = useState('');
  const [pharmAmt, setPharmAmt] = useState('');

  // Debounced so a payroll number typed at speed is one query, not six.
  //
  // Both setState calls live INSIDE the timer, never in the effect body. A
  // setState run synchronously while an effect is committing schedules another
  // render before the browser paints, and React warns about it — the spinner
  // belongs to the request, so it starts when the request does.
  useEffect(() => {
    const q = query.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      if (q.length < 2) { setResults([]); setSearching(false); return; }
      setSearching(true);
      const { data } = await supabase.rpc('lookup_scheme_member', {
        p_scheme_id: scheme.id, p_query: q,
      });
      if (!cancelled) { setResults((data ?? []) as SchemeMemberLookup[]); setSearching(false); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, scheme.id]);

  const reset = () => {
    setConsult(''); setLabDesc(''); setLabAmt('');
    setSurgDesc(''); setSurgAmt(''); setPharmDesc(''); setPharmAmt('');
  };

  /**
   * A description with no price, or a price with no description, on any of the
   * three columns. The server refuses both — this says so before the click, so
   * the desk is not taught to expect a rejection.
   */
  const pairProblem = (desc: string, amt: string, label: string): string | null => {
    const hasDesc = desc.trim() !== '';
    const cents = amt.trim() === '' ? 0 : parseKesToCents(amt);
    if (cents === null) return `${label}: ${amt} is not an amount.`;
    if (hasDesc && cents === 0) return `${label}: enter what it costs, or clear the description.`;
    if (!hasDesc && cents > 0) return `${label}: say what was done, or clear the amount.`;
    return null;
  };

  const problems = [
    pairProblem(labDesc, labAmt, 'Lab'),
    pairProblem(surgDesc, surgAmt, 'Surgical'),
    pairProblem(pharmDesc, pharmAmt, 'Pharmacy'),
    consult.trim() !== '' && parseKesToCents(consult) === null
      ? `Consultation: ${consult} is not an amount.` : null,
  ].filter(Boolean) as string[];

  const consultCents = consult.trim() === ''
    ? scheme.consultation_fee_cents
    : (parseKesToCents(consult) ?? 0);
  const runningTotal = consultCents
    + (parseKesToCents(labAmt) ?? 0)
    + (parseKesToCents(surgAmt) ?? 0)
    + (parseKesToCents(pharmAmt) ?? 0);

  const submit = async () => {
    if (!member) return;
    setBusy(true); setErr(null); setWarn(null);
    const { data, error } = await supabase.rpc('post_scheme_charge', {
      p_member_id: member.member_id,
      p_service_date: date,
      p_lab_description: labDesc.trim() || null,
      p_lab_cents: parseKesToCents(labAmt) ?? 0,
      p_surgical_description: surgDesc.trim() || null,
      p_surgical_cents: parseKesToCents(surgAmt) ?? 0,
      p_pharmacy_description: pharmDesc.trim() || null,
      p_pharmacy_cents: parseKesToCents(pharmAmt) ?? 0,
      p_encounter_id: null,
      p_consultation_cents: consult.trim() === '' ? null : parseKesToCents(consult),
    });
    if (error) { setErr(error.message); setBusy(false); return; }

    const row = (Array.isArray(data) ? data[0] : data) as {
      total_cents: number; over_limit: boolean;
      cap_cents: number | null; remaining_cents: number | null;
    } | null;

    reset();
    setBusy(false);
    if (row?.over_limit) {
      // Warned, recorded, flagged — never refused. The patient is standing
      // there; the budget is a conversation with the farm, not with them.
      setWarn(
        `Recorded ${formatKes(row.total_cents)}. This visit takes ${scheme.name} past its `
        + `${row.cap_cents !== null ? formatKes(row.cap_cents) : ''} limit for the month by `
        + `${formatKes(Math.abs(row.remaining_cents ?? 0))}. It is flagged on the statement `
        + `for the company to approve.`,
      );
    }
    await onPosted(
      `${formatKes(row?.total_cents ?? 0)} recorded for ${member.full_name}`
      + (row?.remaining_cents != null && row.remaining_cents >= 0
        ? ` · ${formatKes(row.remaining_cents)} left this month.` : '.'),
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      {/* Who */}
      <Card>
        <CardHeader title="Who is being seen" subtitle="Payroll number, name or MRN." />
        <CardBody className="pt-0">
          <label className="relative block">
            <span className="sr-only">Search members</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setMember(null); }}
              placeholder="e.g. 646 or ZAKIUS"
              className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
            />
          </label>

          {searching && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Searching…
            </p>
          )}

          {member ? (
            <div className="mt-3 rounded-lg border border-brand bg-brand-wash/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{member.full_name}</p>
                  <p className="text-2xs text-ink-muted">
                    {memberRole(member)} · payroll {member.employee_no} · {member.mrn}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMember(null)}
                  className="rounded p-1 text-ink-muted hover:bg-surface-sunken"
                  aria-label="Choose someone else"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
              {!member.covered && (
                <p className="mt-2 flex items-start gap-1.5 text-2xs text-critical-ink">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  Cover ended {member.covered_to ? dayLabel(member.covered_to) : ''}. The
                  charge will be refused — check with the employer before treating on account.
                </p>
              )}
              <p className="mt-2 text-2xs text-ink-muted">
                This household ({member.household_size} {member.household_size === 1 ? 'person' : 'people'})
                has spent {formatKes(member.month_spend_cents)} so far this month.
              </p>
            </div>
          ) : (
            !!results.length && (
              <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {results.map((m) => (
                  <li key={m.member_id}>
                    <button
                      type="button"
                      onClick={() => { setMember(m); setResults([]); }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-sunken"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink">{m.full_name}</span>
                        <span className="block text-2xs text-ink-muted">
                          {memberRole(m)} · payroll {m.employee_no}
                          {m.employee_name && m.relation !== 'SELF' && ` · under ${m.employee_name}`}
                        </span>
                      </span>
                      {!m.covered && <StatusBadge tone="critical" label="Not covered" icon={false} />}
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          {query.trim().length >= 2 && !searching && !results.length && !member && (
            <p className="mt-3 text-xs text-ink-muted">
              Nobody on {scheme.name}&rsquo;s register matches that. If they are a new
              employee or dependant, enrol them under <strong>Staff &amp; dependants</strong> first.
            </p>
          )}
        </CardBody>
      </Card>

      {/* What */}
      <Card>
        <CardHeader
          title="What was done"
          subtitle={`Prices are entered by hand. Consultation defaults to ${scheme.name}'s contract fee of ${formatKes(scheme.consultation_fee_cents)}.`}
        />
        <CardBody className="space-y-3 pt-0">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date of visit">
              <input
                type="date"
                value={date}
                max={today}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
              />
            </Field>
            <Field label="Consultation (KSh)" hint="Leave blank for the contract fee">
              <input
                inputMode="decimal"
                value={consult}
                onChange={(e) => setConsult(e.target.value)}
                placeholder={formatKes(scheme.consultation_fee_cents, { symbol: false })}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
              />
            </Field>
          </div>

          <PairRow
            label="Lab" descPlaceholder="e.g. STOOL/HPYLORI/UA"
            desc={labDesc} setDesc={setLabDesc} amt={labAmt} setAmt={setLabAmt}
          />
          <PairRow
            label="Surgical" descPlaceholder="e.g. cleaning and dressing"
            desc={surgDesc} setDesc={setSurgDesc} amt={surgAmt} setAmt={setSurgAmt}
          />
          <PairRow
            label="Pharmacy" descPlaceholder="e.g. diclo inj/tabs/gel/cetrizin"
            desc={pharmDesc} setDesc={setPharmDesc} amt={pharmAmt} setAmt={setPharmAmt}
          />

          {problems.map((p) => (
            <StatusBadge key={p} tone="warning" label={p} />
          ))}
          {err && <StatusBadge tone="critical" label={err} />}
          {warn && <StatusBadge tone="warning" label={warn} />}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <p className="text-sm text-ink-secondary">
              Visit total{' '}
              <span className="text-base font-semibold text-ink">{formatKes(runningTotal)}</span>
            </p>
            <button
              type="button"
              disabled={!member || busy || problems.length > 0 || !canPost || runningTotal <= 0}
              onClick={submit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
              Record visit
            </button>
          </div>
          {!canPost && (
            <p className="text-2xs text-ink-muted">
              Your role can view scheme activity but not record it.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-secondary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-ink-muted">{hint}</span>}
    </label>
  );
}

/** A description and its price, side by side — because on these sheets one
 *  without the other is the defect the whole module exists to stop. */
function PairRow({
  label, descPlaceholder, desc, setDesc, amt, setAmt,
}: {
  label: string;
  descPlaceholder: string;
  desc: string;
  setDesc: (v: string) => void;
  amt: string;
  setAmt: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
      <Field label={label}>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={descPlaceholder}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
        />
      </Field>
      <Field label={`${label} (KSh)`}>
        <input
          inputMode="decimal"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          placeholder="0.00"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
        />
      </Field>
    </div>
  );
}

// ── Visit register ─────────────────────────────────────────────────────
function VisitRegister({ scheme, today, role }: { scheme: Scheme; today: string; role: string }) {
  const thisMonth = periodOf(today);
  const [from, setFrom] = useState(thisMonth);
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<SchemeCharge[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const { data, error } = await supabase.rpc('list_scheme_charges', {
      p_scheme_id: scheme.id, p_from: from, p_to: to, p_include_void: true,
    });
    if (error) setErr(error.message);
    setRows((data ?? []) as SchemeCharge[]);
    setLoading(false);
  }, [scheme.id, from, to]);

  // Deferred by a tick rather than called straight from the effect body. Two
  // reasons, and the second is the one that matters: load() sets state
  // synchronously, which React warns about inside an effect; and dragging a
  // date input emits a change per day, so without this a two-week drag would
  // fire fourteen queries.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 150);
    return () => clearTimeout(t);
  }, [load]);

  const live = rows.filter((r) => r.status !== 'VOID');
  const total = live.reduce((a, r) => a + r.total_cents, 0);

  return (
    <Card>
      <CardHeader
        title="Visit register"
        subtitle={`${live.length} visit${live.length === 1 ? '' : 's'} · ${formatKes(total)}`}
        action={<div className="flex gap-2"><DownloadButtons schemeId={scheme.id} from={from} to={to} /></div>}
      />
      <CardSection>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" />
          </Field>
          <Field label="To">
            <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" />
          </Field>
          <div className="flex flex-wrap gap-2 pb-0.5">
            <Preset label="This week" onClick={() => { const [a, b] = weekOf(today); setFrom(a); setTo(b > today ? today : b); }} />
            <Preset label="Last week" onClick={() => {
              const [a] = weekOf(today);
              const prevEnd = new Date(Date.parse(`${a}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
              const [pa, pb] = weekOf(prevEnd);
              setFrom(pa); setTo(pb);
            }} />
            <Preset label="This month" onClick={() => { setFrom(thisMonth); setTo(today); }} />
            <Preset label="Last month" onClick={() => {
              const prev = recentPeriods(today, 2)[1];
              setFrom(prev); setTo(periodEnd(prev));
            }} />
          </div>
        </div>
      </CardSection>

      <CardBody className="pt-4">
        {err && <StatusBadge tone="critical" label={err} />}
        {loading ? (
          <p className="flex items-center gap-1.5 py-4 text-sm text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the register…
          </p>
        ) : !rows.length ? (
          <p className="py-4 text-sm text-ink-muted">
            No visits recorded for {scheme.name} between {dayLabel(from)} and {dayLabel(to)}.
          </p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase tracking-wide text-ink-muted">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Payroll</th>
                  <th className="px-3 py-2 text-right font-medium">Cons</th>
                  <th className="px-3 py-2 font-medium">Lab</th>
                  <th className="px-3 py-2 font-medium">Surgical</th>
                  <th className="px-3 py-2 font-medium">Pharmacy</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.charge_id} className={r.status === 'VOID' ? 'text-ink-muted line-through' : ''}>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{dayLabel(r.service_date)}</td>
                    <td className="px-3 py-2">
                      <span className="block text-ink">{r.full_name}</span>
                      <span className="block text-2xs text-ink-muted">{memberRole(r)}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.employee_no}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatKes(r.consultation_cents, { symbol: false })}</td>
                    <td className="max-w-[160px] px-3 py-2 text-xs">
                      {r.lab_description && (
                        <>
                          <span className="block truncate text-ink-secondary" title={r.lab_description}>{r.lab_description}</span>
                          <span className="block tabular-nums text-ink-muted">{formatKes(r.lab_cents, { symbol: false })}</span>
                        </>
                      )}
                    </td>
                    <td className="max-w-[160px] px-3 py-2 text-xs">
                      {r.surgical_description && (
                        <>
                          <span className="block truncate text-ink-secondary" title={r.surgical_description}>{r.surgical_description}</span>
                          <span className="block tabular-nums text-ink-muted">{formatKes(r.surgical_cents, { symbol: false })}</span>
                        </>
                      )}
                    </td>
                    <td className="max-w-[220px] px-3 py-2 text-xs">
                      {r.pharmacy_description && (
                        <>
                          <span className="block truncate text-ink-secondary" title={r.pharmacy_description}>{r.pharmacy_description}</span>
                          <span className="block tabular-nums text-ink-muted">{formatKes(r.pharmacy_cents, { symbol: false })}</span>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums text-ink">
                      {formatKes(r.total_cents, { symbol: false })}
                      {r.over_limit && (
                        <span className="ml-1 text-critical-ink" title="Took the month past the agreed limit">*</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.status === 'OPEN' && ['ADMIN', 'RECEPTIONIST'].includes(role) && (
                        <button
                          type="button"
                          disabled={voiding === r.charge_id}
                          onClick={async () => {
                            const reason = window.prompt(`Why is ${r.full_name}'s visit on ${dayLabel(r.service_date)} being voided?`);
                            if (!reason?.trim()) return;
                            setVoiding(r.charge_id);
                            const { error } = await supabase.rpc('void_scheme_charge', {
                              p_charge_id: r.charge_id, p_reason: reason.trim(),
                            });
                            if (error) setErr(error.message);
                            setVoiding(null);
                            await load();
                          }}
                          className="text-2xs text-ink-muted underline hover:text-critical-ink"
                        >
                          Void
                        </button>
                      )}
                      {r.status === 'STATEMENTED' && (
                        <span className="text-2xs text-ink-muted">Invoiced</span>
                      )}
                      {r.status === 'VOID' && r.void_reason && (
                        <span className="text-2xs text-ink-muted" title={r.void_reason}>Voided</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Preset({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-2 text-xs font-medium text-ink hover:bg-surface-sunken"
    >
      <CalendarRange className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}

// ── Members ────────────────────────────────────────────────────────────
function MemberRegister({
  scheme, canEnrol, today,
}: {
  scheme: Scheme;
  canEnrol: boolean;
  today: string;
}) {
  const [query, setQuery] = useState('');
  const [includeEnded, setIncludeEnded] = useState(false);
  const [rows, setRows] = useState<SchemeMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('list_scheme_members', {
      p_scheme_id: scheme.id, p_query: query.trim() || null, p_include_ended: includeEnded,
    });
    if (error) setErr(error.message);
    setRows((data ?? []) as SchemeMember[]);
    setLoading(false);
  }, [scheme.id, query, includeEnded]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  const households = useMemo(() => {
    const map = new Map<string, SchemeMember[]>();
    for (const m of rows) {
      const list = map.get(m.employee_no);
      if (list) list.push(m); else map.set(m.employee_no, [m]);
    }
    return [...map.entries()];
  }, [rows]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`${scheme.name} — staff and dependants`}
          subtitle="A spouse and children are enrolled under the employee's payroll number, which is how the company already bills."
          action={
            canEnrol ? (
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong"
              >
                <UserPlus className="h-4 w-4" aria-hidden />
                {adding ? 'Close' : 'Add someone'}
              </button>
            ) : undefined
          }
        />
        {adding && canEnrol && (
          <CardSection>
            <EnrolForm
              scheme={scheme}
              onDone={async (msg) => { setOk(msg); setErr(null); setAdding(false); await load(); }}
              onError={(m) => { setErr(m); setOk(null); }}
            />
          </CardSection>
        )}
        <CardBody className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="relative block flex-1 min-w-[220px]">
              <span className="sr-only">Search the register</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Payroll number, name or MRN"
                className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 pb-2 text-xs text-ink-secondary">
              <input
                type="checkbox"
                checked={includeEnded}
                onChange={(e) => setIncludeEnded(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-line"
              />
              Show people whose cover has ended
            </label>
          </div>

          {err && <div className="mt-3"><StatusBadge tone="critical" label={err} /></div>}
          {ok && !err && <div className="mt-3"><StatusBadge tone="good" label={ok} /></div>}

          {loading ? (
            <p className="flex items-center gap-1.5 py-4 text-sm text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the register…
            </p>
          ) : !households.length ? (
            <p className="py-4 text-sm text-ink-muted">
              {query.trim()
                ? `Nobody on ${scheme.name}'s register matches that.`
                : `No one is enrolled on ${scheme.name} yet.`}
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {households.map(([payroll, people]) => (
                <li key={payroll} className="rounded-lg border border-line">
                  <div className="flex items-center gap-2 border-b border-line bg-surface-sunken/60 px-3 py-2">
                    <Users2 className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
                    <span className="text-xs font-semibold text-ink">Payroll {payroll}</span>
                    <span className="text-2xs text-ink-muted">
                      {people.length} {people.length === 1 ? 'person' : 'people'}
                    </span>
                  </div>
                  <ul className="divide-y divide-line">
                    {people.map((m) => (
                      <li key={m.member_id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-ink">{m.full_name}</p>
                          <p className="text-2xs text-ink-muted">
                            {memberRole(m)} · {m.mrn}
                            {m.employment_type && ` · ${EMPLOYMENT_LABEL[m.employment_type]}`}
                            {m.dob && ` · born ${dayLabel(m.dob)}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {m.visits_this_month > 0 && (
                            <span className="text-2xs text-ink-muted">
                              {m.visits_this_month} visit{m.visits_this_month === 1 ? '' : 's'} ·{' '}
                              {formatKes(m.spend_this_month_cents)}
                            </span>
                          )}
                          {m.covered ? (
                            <StatusBadge tone="good" label="Covered" icon={false} />
                          ) : (
                            <StatusBadge
                              tone="neutral"
                              label={m.covered_to ? `Ended ${dayLabel(m.covered_to)}` : 'Not covered'}
                              icon={false}
                            />
                          )}
                          {canEnrol && m.covered && (
                            <button
                              type="button"
                              onClick={async () => {
                                const what = m.relation === 'SELF'
                                  ? `End cover for ${m.full_name} AND their dependants?`
                                  : `End cover for ${m.full_name}?`;
                                if (!window.confirm(`${what}\n\nPast visits stay on the record and on any statement already issued.`)) return;
                                const { error } = await supabase.rpc('end_scheme_membership', {
                                  p_member_id: m.member_id, p_covered_to: today, p_note: null,
                                });
                                if (error) { setErr(error.message); return; }
                                setOk(`Cover ended for ${m.full_name}.`);
                                await load();
                              }}
                              className="text-2xs text-ink-muted underline hover:text-critical-ink"
                            >
                              End cover
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function EnrolForm({
  scheme, onDone, onError,
}: {
  scheme: Scheme;
  onDone: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [employeeNo, setEmployeeNo] = useState('');
  const [relation, setRelation] = useState<Relation>('SELF');
  const [childRef, setChildRef] = useState('');
  const [fullName, setFullName] = useState('');
  const [dob, setDob] = useState('');
  const [sex, setSex] = useState('');
  const [phone, setPhone] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [memberNo, setMemberNo] = useState('');
  const [employment, setEmployment] = useState<EmploymentType | ''>('');
  const [employedOn, setEmployedOn] = useState('');

  const submit = async () => {
    setBusy(true);
    const { error } = await supabase.rpc('enrol_scheme_member', {
      p_scheme_id: scheme.id,
      p_employee_no: employeeNo.trim(),
      p_relation: relation,
      p_full_name: fullName.trim(),
      p_dob: dob || null,
      p_sex: sex || null,
      p_phone: phone.trim() || null,
      p_national_id: nationalId.trim() || null,
      p_member_no: memberNo.trim() || null,
      p_child_ref: relation === 'CHILD' ? (childRef.trim().toUpperCase() || null) : null,
      p_employment_type: relation === 'SELF' ? (employment || null) : null,
      p_employed_on: relation === 'SELF' ? (employedOn || null) : null,
      p_patient_id: null,
      p_note: null,
    });
    setBusy(false);
    if (error) { onError(error.message); return; }
    const name = fullName.trim();
    setFullName(''); setDob(''); setSex(''); setPhone(''); setNationalId(''); setMemberNo(''); setChildRef('');
    await onDone(`${name} enrolled on ${scheme.name}.`);
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Employee payroll number" hint="A dependant carries the employee's number">
          <input value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} placeholder="e.g. 646"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" />
        </Field>
        <Field label="Who is this">
          <select value={relation} onChange={(e) => setRelation(e.target.value as Relation)}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none">
            <option value="SELF">The employee</option>
            <option value="SPOUSE">Spouse</option>
            <option value="CHILD">Child</option>
          </select>
        </Field>
        {relation === 'CHILD' ? (
          <Field label="Child reference" hint="A, B, C or D — as on the company's register">
            <input value={childRef} maxLength={1} onChange={(e) => setChildRef(e.target.value)} placeholder="A"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm uppercase text-ink focus:border-brand focus:outline-none" />
          </Field>
        ) : (
          <Field label="Member number" hint="Optional — the card number, if one is issued">
            <input value={memberNo} onChange={(e) => setMemberNo(e.target.value)} placeholder="e.g. LPO9836-SP"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" />
          </Field>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <Field label="Full name">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="FIRST MIDDLE LAST"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" />
          </Field>
        </div>
        <Field label="Date of birth">
          <input type="date" value={dob} onChange={(e) => setDob(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" />
        </Field>
        <Field label="Sex">
          <select value={sex} onChange={(e) => setSex(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none">
            <option value="">Not recorded</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Mobile"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07xx xxx xxx"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" /></Field>
        <Field label="National ID"><input value={nationalId} onChange={(e) => setNationalId(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" /></Field>
        {relation === 'SELF' && (
          <>
            <Field label="Employment">
              <select value={employment} onChange={(e) => setEmployment(e.target.value as EmploymentType | '')}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none">
                <option value="">Not recorded</option>
                <option value="PERMANENT">Permanent</option>
                <option value="CONTRACT">Contract</option>
                <option value="SEASONAL">Seasonal</option>
              </select>
            </Field>
            <Field label="Employed since">
              <input type="date" value={employedOn} onChange={(e) => setEmployedOn(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none" />
            </Field>
          </>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={busy || !employeeNo.trim() || !fullName.trim()}
          onClick={submit}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
          Enrol
        </button>
      </div>
    </div>
  );
}

// ── Statements and the limit ───────────────────────────────────────────
function Statements({
  scheme, statements, current, today, canIssue, canSetLimit, onChanged, onError,
}: {
  scheme: Scheme;
  statements: SchemeStatement[];
  current: SchemeUtilisation | undefined;
  today: string;
  canIssue: boolean;
  canSetLimit: boolean;
  onChanged: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState(
    current?.cap_cents != null ? formatKes(current.cap_cents, { symbol: false }) : '',
  );
  const [effective, setEffective] = useState(periodOf(today));

  const capCents = cap.trim() === '' ? null : parseKesToCents(cap);
  const capInvalid = cap.trim() !== '' && capCents === null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Monthly limit"
          subtitle="The ceiling agreed with the company. Changing it writes a dated entry, so an earlier month keeps reporting against the limit that applied then."
        />
        <CardBody className="pt-0">
          {canSetLimit ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Limit (KSh per month)">
                <input
                  inputMode="decimal"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  placeholder="e.g. 150000.00"
                  className="w-44 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
                />
              </Field>
              <Field label="Applies from" hint="Always the 1st of that month">
                <input
                  type="month"
                  value={effective.slice(0, 7)}
                  onChange={(e) => setEffective(`${e.target.value}-01`)}
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
                />
              </Field>
              <button
                type="button"
                disabled={busy || capCents === null || capInvalid}
                onClick={async () => {
                  if (capCents === null) return;
                  setBusy(true);
                  const { error } = await supabase.rpc('set_scheme_limit', {
                    p_scheme_id: scheme.id,
                    p_effective_from: effective,
                    p_monthly_cap_cents: capCents,
                    p_note: null,
                  });
                  setBusy(false);
                  if (error) { onError(error.message); return; }
                  await onChanged(
                    `${scheme.name}'s limit set to ${formatKes(capCents)} a month from ${periodLabel(effective)}.`,
                  );
                }}
                className="mb-0.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
              >
                Save limit
              </button>
              {capInvalid && <StatusBadge tone="warning" label={`${cap} is not an amount.`} />}
            </div>
          ) : (
            <p className="text-sm text-ink-secondary">
              {current?.cap_cents != null
                ? `${formatKes(current.cap_cents)} a month.`
                : 'No limit has been agreed yet.'}{' '}
              <span className="text-ink-muted">Only an administrator can change it.</span>
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Statements"
          subtitle="One per month. Preparing a draft is safe and repeatable; issuing it closes the month."
        />
        <CardBody className="pt-0">
          {!statements.length ? (
            <p className="py-2 text-sm text-ink-muted">
              No statement has been prepared for {scheme.name} yet.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {statements.map((s) => {
                const issuable = canIssueStatement(s, today);
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        {periodLabel(s.period)}
                        {s.statement_no && (
                          <span className="ml-2 font-normal text-ink-muted">{s.statement_no}</span>
                        )}
                      </p>
                      <p className="text-2xs text-ink-muted">
                        {s.visits} visit{s.visits === 1 ? '' : 's'} · {formatKes(s.total_cents)}
                        {s.cap_cents != null && ` · limit ${formatKes(s.cap_cents)}`}
                        {s.over_limit_cents > 0 && ` · ${formatKes(s.over_limit_cents)} over limit`}
                        {s.issued_at && s.issued_by_name && ` · issued by ${s.issued_by_name}`}
                      </p>
                      {s.void_reason && (
                        <p className="text-2xs text-critical-ink">Voided: {s.void_reason}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge
                        tone={s.status === 'ISSUED' ? 'good' : s.status === 'VOID' ? 'neutral' : 'warning'}
                        label={STATEMENT_STATUS_LABEL[s.status]}
                        icon={false}
                      />
                      <DownloadButtons schemeId={scheme.id} period={s.period} />
                      {s.status === 'DRAFT' && canIssue && (
                        <button
                          type="button"
                          disabled={busy || !issuable}
                          title={issuable ? undefined : 'A month can only be invoiced once it is over and has visits on it.'}
                          onClick={async () => {
                            if (!window.confirm(
                              `Issue the ${periodLabel(s.period)} statement for ${scheme.name}?\n\n`
                              + 'This gives it a number and closes the month — no further visits can be '
                              + 'recorded against it, and its charges can no longer be edited.',
                            )) return;
                            setBusy(true);
                            const { data, error } = await supabase.rpc('issue_scheme_statement', {
                              p_statement_id: s.id,
                            });
                            setBusy(false);
                            if (error) { onError(error.message); return; }
                            await onChanged(`Statement ${String(data)} issued.`);
                          }}
                          className="rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-strong disabled:opacity-50"
                        >
                          Issue
                        </button>
                      )}
                      {s.status === 'ISSUED' && canIssue && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            const reason = window.prompt(
                              `Why is statement ${s.statement_no} being voided?\n\n`
                              + 'Its visits go back to being editable and the month can be re-cut. '
                              + 'The voided statement stays on the record.',
                            );
                            if (!reason?.trim()) return;
                            setBusy(true);
                            const { error } = await supabase.rpc('void_scheme_statement', {
                              p_statement_id: s.id, p_reason: reason.trim(),
                            });
                            setBusy(false);
                            if (error) { onError(error.message); return; }
                            await onChanged(`Statement ${s.statement_no} voided.`);
                          }}
                          className="text-2xs text-ink-muted underline hover:text-critical-ink"
                        >
                          Void
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 flex items-start gap-1.5 text-2xs text-ink-muted">
            <Download className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            Excel matches the company&rsquo;s own sheet layout, day by day. PDF is the
            statement to send. Both are generated fresh each time, never cached.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
