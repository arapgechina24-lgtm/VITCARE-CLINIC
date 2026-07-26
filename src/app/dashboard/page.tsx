import Link from 'next/link';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';

type EncounterRow = {
  id: string;
  patient_id: string;
  patient_full_name: string;
  patient_mrn: string;
  status: string;
  chief_complaint: string | null;
  triage_priority: string | null;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  TRIAGE: 'Awaiting triage',
  IN_CONSULT: 'In consult',
};

const NEXT_STEP_HREF: Record<string, (id: string) => string> = {
  TRIAGE: (id) => `/dashboard/triage/${id}`,
  IN_CONSULT: (id) => `/dashboard/consult/${id}`,
};

export default async function QueuePage() {
  const staff = await requireStaffContext();
  if (!staff.siteId) {
    return <p className="text-ink/60">Your account isn&apos;t assigned to a site yet — ask an admin to add a row to user_site_memberships.</p>;
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('list_encounters', { p_site_id: staff.siteId });
  const encounters = (data ?? []) as EncounterRow[];

  return (
    <div>
      <h1 className="font-display text-xl font-bold mb-4">Today&apos;s queue</h1>
      {error && <p className="text-alert text-sm mb-3">{error.message}</p>}
      {encounters.length === 0 ? (
        <p className="text-ink/60">Nothing in the queue. Register a patient to start a visit.</p>
      ) : (
        <ul className="space-y-2">
          {encounters
            .filter((e) => e.status === 'TRIAGE' || e.status === 'IN_CONSULT')
            .map((e) => (
              <li key={e.id} className="rounded-lg border border-ink/10 p-3 flex items-center justify-between">
                <div>
                  <p className="font-medium">{e.patient_full_name} <span className="text-ink/40 text-xs">{e.patient_mrn}</span></p>
                  <p className="text-sm text-ink/60">
                    {STATUS_LABEL[e.status] ?? e.status}
                    {e.chief_complaint ? ` · ${e.chief_complaint}` : ''}
                    {e.triage_priority ? ` · ${e.triage_priority}` : ''}
                  </p>
                </div>
                <Link
                  href={NEXT_STEP_HREF[e.status]?.(e.id) ?? '/dashboard'}
                  className="rounded-lg bg-clinic text-white text-sm px-3 py-1.5"
                >
                  Continue
                </Link>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
