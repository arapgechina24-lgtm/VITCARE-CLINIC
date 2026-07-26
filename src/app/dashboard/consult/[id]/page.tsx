import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import ConsultForm from './ConsultForm';

export default async function ConsultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: encounter } = await supabase
    .from('encounters')
    .select('id, patient_id, chief_complaint, vitals, triage_priority, clinical_notes, status')
    .eq('id', id)
    .maybeSingle();
  if (!encounter) notFound();

  const { data: patientRows } = await supabase.rpc('get_patient', { p_patient_id: encounter.patient_id });
  const patient = Array.isArray(patientRows) ? patientRows[0] : patientRows;
  const vitals = (encounter.vitals ?? {}) as Record<string, string | null>;

  return (
    <div className="max-w-md">
      <h1 className="font-display text-xl font-bold mb-1">Consult</h1>
      <p className="text-ink/60 mb-1">{patient?.full_name} · {patient?.mrn}</p>
      <p className="text-sm text-ink/60 mb-4">
        {encounter.chief_complaint} · {encounter.triage_priority}
        {vitals.tempC ? ` · ${vitals.tempC}°C` : ''}
        {vitals.bp ? ` · BP ${vitals.bp}` : ''}
        {vitals.pulseBpm ? ` · ${vitals.pulseBpm} bpm` : ''}
        {vitals.spo2Pct ? ` · SpO2 ${vitals.spo2Pct}%` : ''}
      </p>
      <ConsultForm encounterId={encounter.id} initialNotes={encounter.clinical_notes ?? ''} />
    </div>
  );
}
