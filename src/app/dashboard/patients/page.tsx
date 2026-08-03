import Link from 'next/link';
import { Search, UserPlus } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ageFrom } from '@/lib/patient-record';

interface PatientSummary {
  patient_id: string;
  mrn: string;
  full_name: string;
  dob: string | null;
  sex: string | null;
  phone: string | null;
  registered_at: string;
  last_visit_at: string | null;
  visit_count: number;
  open_encounter_id: string | null;
  open_encounter_status: string | null;
}

/**
 * Patient directory.
 *
 * Search runs server-side through the audited RPC rather than filtering a
 * client-side copy of the register — which would mean shipping every patient's
 * details to the browser to answer one lookup, and would log a single access
 * covering the whole population instead of the search that was actually run.
 */
export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const staff = await requireStaffContext();

  if (!staff.siteId) {
    return (
      <Card>
        <CardBody className="pt-5">
          <p className="text-sm text-ink-secondary">
            Your account isn&apos;t assigned to a site yet — ask an administrator to add you to one.
          </p>
        </CardBody>
      </Card>
    );
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('list_patients_summary', {
    p_site_id: staff.siteId,
    p_search: q?.trim() || null,
  });
  const patients = (data ?? []) as PatientSummary[];

  const canRegister = ['RECEPTIONIST', 'NURSE', 'ADMIN'].includes(staff.role);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Patients</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            {patients.length} {patients.length === 1 ? 'record' : 'records'}
            {q ? ` matching “${q}”` : ''}
          </p>
        </div>
        {canRegister && (
          <Link
            href="/dashboard/register"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
          >
            <UserPlus className="h-4 w-4" aria-hidden />
            Register patient
          </Link>
        )}
      </div>

      {/* GET form: the search term lives in the URL, so a lookup is
          shareable, bookmarkable and survives a refresh. */}
      <form method="GET" className="relative max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
          aria-hidden
        />
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search by name, file number or phone"
          aria-label="Search patients"
          className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink shadow-sm placeholder:text-ink-muted focus:border-brand focus:outline-none"
        />
      </form>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={error.message} />
          </CardBody>
        </Card>
      )}

      {patients.length === 0 ? (
        <Card>
          <CardBody className="pt-5">
            <p className="py-10 text-center text-sm text-ink-muted">
              {q ? 'No patients match that search.' : 'No patients registered at this site yet.'}
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-sunken text-left">
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Patient</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">File no.</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Age / sex</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Phone</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Visits</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Last seen</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {patients.map((p) => {
                  const age = ageFrom(p.dob);
                  return (
                    <tr key={p.patient_id} className="bg-surface transition-colors hover:bg-surface-hover">
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/patients/${p.patient_id}`}
                          className="font-medium text-ink hover:text-brand-ink hover:underline"
                        >
                          {p.full_name}
                        </Link>
                      </td>
                      <td className="tabular px-4 py-3 text-xs text-ink-muted">{p.mrn}</td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {age != null ? `${age}y` : '—'}
                        {p.sex ? ` · ${p.sex}` : ''}
                      </td>
                      <td className="tabular px-4 py-3 text-ink-secondary">{p.phone || '—'}</td>
                      <td className="tabular px-4 py-3 text-ink-secondary">{p.visit_count}</td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {p.last_visit_at
                          ? new Date(p.last_visit_at).toLocaleDateString('en-KE', { dateStyle: 'medium' })
                          : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {p.open_encounter_status ? (
                          <StatusBadge
                            tone="warning"
                            label={p.open_encounter_status === 'TRIAGE' ? 'Awaiting triage' : 'In consult'}
                          />
                        ) : (
                          <span className="text-xs text-ink-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
