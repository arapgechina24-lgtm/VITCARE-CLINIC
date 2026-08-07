import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import PrescribeForm from './PrescribeForm';
import type { AllergyStatus, RecordedAllergy } from '@/lib/allergy-check';

interface PatientRecord {
  patient: {
    id: string;
    mrn: string;
    full_name: string;
    allergy_status: AllergyStatus;
    allergies_reviewed_at: string | null;
  };
  allergies: RecordedAllergy[];
}

export default async function PrescribePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: encounter } = await supabase
    .from('encounters')
    .select('id, patient_id, status')
    .eq('id', id)
    .maybeSingle();
  if (!encounter) notFound();

  // get_patient_record rather than get_patient: it is the audited door to the
  // chart, and it carries the allergy history. Fetching allergies separately
  // would be a second, unlogged read of health data.
  const { data } = await supabase.rpc('get_patient_record', { p_patient_id: encounter.patient_id });
  const record = data as PatientRecord | null;
  if (!record?.patient) notFound();

  const { data: sites } = await supabase.from('sites').select('id, name').eq('active', true);

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-xl font-bold mb-1">Prescribe</h1>
      <p className="text-ink/60 mb-4">
        {record.patient.full_name} · {record.patient.mrn}
      </p>
      <PrescribeForm
        encounterId={encounter.id}
        patientId={encounter.patient_id}
        sites={sites ?? []}
        // Defaults to UNRECORDED rather than assuming none: a patient row
        // written before 0010 has no status, and the safe reading of "we don't
        // know" is "go and ask", never "nothing to worry about".
        allergyStatus={record.patient.allergy_status ?? 'UNRECORDED'}
        allergies={record.allergies ?? []}
        allergiesReviewedAt={record.patient.allergies_reviewed_at}
      />
    </div>
  );
}
