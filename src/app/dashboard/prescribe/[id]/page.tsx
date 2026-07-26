import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import PrescribeForm from './PrescribeForm';

export default async function PrescribePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: encounter } = await supabase
    .from('encounters')
    .select('id, patient_id, status')
    .eq('id', id)
    .maybeSingle();
  if (!encounter) notFound();

  const { data: patientRows } = await supabase.rpc('get_patient', { p_patient_id: encounter.patient_id });
  const patient = Array.isArray(patientRows) ? patientRows[0] : patientRows;

  const { data: sites } = await supabase.from('sites').select('id, name').eq('active', true);

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-xl font-bold mb-1">Prescribe</h1>
      <p className="text-ink/60 mb-4">{patient?.full_name} · {patient?.mrn}</p>
      <PrescribeForm encounterId={encounter.id} sites={sites ?? []} />
    </div>
  );
}
