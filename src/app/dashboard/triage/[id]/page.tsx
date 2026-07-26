import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import TriageForm from './TriageForm';

export default async function TriagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: encounter } = await supabase
    .from('encounters')
    .select('id, patient_id, chief_complaint, status')
    .eq('id', id)
    .maybeSingle();
  if (!encounter) notFound();

  const { data: patientRows } = await supabase.rpc('get_patient', { p_patient_id: encounter.patient_id });
  const patient = Array.isArray(patientRows) ? patientRows[0] : patientRows;

  return (
    <div className="max-w-md">
      <h1 className="font-display text-xl font-bold mb-1">Triage</h1>
      <p className="text-ink/60 mb-4">{patient?.full_name} · {patient?.mrn}</p>
      <TriageForm encounterId={encounter.id} initialChiefComplaint={encounter.chief_complaint ?? ''} />
    </div>
  );
}
