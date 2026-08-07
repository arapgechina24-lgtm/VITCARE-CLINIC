import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Phone } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PatientRecordTabs } from '@/components/patient/PatientRecordTabs';
import { AllergySection } from '@/components/patient/AllergySection';
import { ageFrom, activeEncounter, allergyStatusOf, type PatientRecord } from '@/lib/patient-record';

/**
 * The patient record.
 *
 * The whole chart arrives in one `get_patient_record` call, which is also what
 * writes the audit entry. That coupling is the point: there is no way to render
 * this page without the access being logged, because the data and the log entry
 * come from the same function.
 */
export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const staff = await requireStaffContext();
  const supabase = await supabaseServer();

  const { data, error } = await supabase.rpc('get_patient_record', { p_patient_id: id });

  if (error) {
    // The RPC raises for both "no such patient" and "not your site". Showing
    // 404 either way is deliberate — telling an unauthorised caller that a
    // record exists but isn't theirs is itself a disclosure.
    notFound();
  }

  const record = data as PatientRecord | null;
  if (!record?.patient) notFound();

  const p = record.patient;
  const age = ageFrom(p.dob);
  const open = activeEncounter(record.encounters);

  // Writing notes is a clinical act; the database enforces this too. The UI
  // just explains it rather than presenting a control that would fail.
  const canWriteNotes = ['CLINICIAN', 'ADMIN'].includes(staff.role);

  return (
    <div className="space-y-5">
      <Link
        href="/dashboard/patients"
        className="inline-flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        All patients
      </Link>

      <Card>
        <CardBody className="pt-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-wash text-sm font-semibold text-brand-ink">
                {p.full_name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight text-ink">{p.full_name}</h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
                  <span className="tabular">{p.mrn}</span>
                  {age != null && <span>· {age} years</span>}
                  {p.sex && <span>· {p.sex}</span>}
                  {p.phone && (
                    <a href={`tel:${p.phone}`} className="flex items-center gap-1 text-brand-ink hover:underline">
                      <Phone className="h-3 w-3" aria-hidden />
                      <span className="tabular">{p.phone}</span>
                    </a>
                  )}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {open ? (
                <>
                  <StatusBadge
                    tone="warning"
                    label={open.status === 'TRIAGE' ? 'Awaiting triage' : 'In consult'}
                  />
                  <Link
                    href={open.status === 'TRIAGE' ? `/dashboard/triage/${open.id}` : `/dashboard/consult/${open.id}`}
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
                  >
                    Continue visit
                  </Link>
                </>
              ) : (
                <StatusBadge tone="neutral" label="No visit in progress" />
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Above the tabs, never inside one. Allergies are not one view among
          five — a fact you can tab away from is a fact you will. */}
      <AllergySection
        patientId={p.id}
        status={allergyStatusOf(record)}
        allergies={record.allergies ?? []}
        reviewedAt={p.allergies_reviewed_at}
        canEdit={['CLINICIAN', 'NURSE', 'ADMIN'].includes(staff.role)}
      />

      <Card>
        <CardBody className="pt-4">
          <PatientRecordTabs
            record={record}
            role={staff.role}
            canWriteNotes={canWriteNotes}
            noteBlockedReason={
              canWriteNotes ? undefined : 'Only a clinician can record consultation notes.'
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}
