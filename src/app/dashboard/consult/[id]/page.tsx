import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import ConsultForm, { type RecordedService } from './ConsultForm';
import { requireStaffContext } from '@/lib/session';
import { requireRole } from '@/lib/require-role';
import { CAN } from '@/lib/roles';
import type { CatalogueService } from '@/lib/catalogue';

export default async function ConsultPage({ params }: { params: Promise<{ id: string }> }) {
  // Consultation notes are a clinical act; save_consult_notes enforces it too.
  await requireRole('CLINICIAN', 'ADMIN');
  const staff = await requireStaffContext();
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: encounter } = await supabase
    .from('encounters')
    .select('id, patient_id, chief_complaint, vitals, triage_priority, clinical_notes, status')
    .eq('id', id)
    .maybeSingle();
  if (!encounter) notFound();

  // The catalogue is fetched at the CASH rate. That is the right default here:
  // this screen records what was done, not what it costs, and the figures shown
  // beside each service are the walk-in price for orientation only. What the
  // patient actually pays is decided on the invoice, from its payer.
  const [{ data: patientRows }, { data: svcData }, { data: recordedData }] = await Promise.all([
    supabase.rpc('get_patient', { p_patient_id: encounter.patient_id }),
    staff.siteId
      ? supabase.rpc('list_service_catalog', { p_site_id: staff.siteId, p_payer: 'CASH' })
      : Promise.resolve({ data: [] }),
    supabase.rpc('list_encounter_services', { p_encounter_id: id }),
  ]);

  const patient = Array.isArray(patientRows) ? patientRows[0] : patientRows;
  const vitals = (encounter.vitals ?? {}) as Record<string, string | null>;

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-xl font-bold mb-1">Consult</h1>
      <p className="text-ink/60 mb-1">{patient?.full_name} · {patient?.mrn}</p>
      <p className="text-sm text-ink/60 mb-4">
        {encounter.chief_complaint} · {encounter.triage_priority}
        {vitals.tempC ? ` · ${vitals.tempC}°C` : ''}
        {vitals.bp ? ` · BP ${vitals.bp}` : ''}
        {vitals.pulseBpm ? ` · ${vitals.pulseBpm} bpm` : ''}
        {vitals.spo2Pct ? ` · SpO2 ${vitals.spo2Pct}%` : ''}
      </p>
      <ConsultForm
        encounterId={encounter.id}
        initialNotes={encounter.clinical_notes ?? ''}
        services={(svcData ?? []) as CatalogueService[]}
        initialRecorded={(recordedData ?? []) as RecordedService[]}
        canRecordServices={CAN.recordService(staff.role)}
      />
    </div>
  );
}
