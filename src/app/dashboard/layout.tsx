import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/app/AppShell';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  CLINICIAN: 'Clinician',
  NURSE: 'Nurse',
  RECEPTIONIST: 'Receptionist',
  PHARMACIST: 'Pharmacist',
  AUDITOR: 'Auditor',
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaffContext();
  const supabase = await supabaseServer();

  // Site name for the sidebar. `sites` is readable by any authenticated user
  // and holds no patient data, so this is a plain select rather than an
  // audited RPC.
  let siteName: string | null = null;
  if (staff.siteId) {
    const { data } = await supabase.from('sites').select('name').eq('id', staff.siteId).maybeSingle();
    siteName = data?.name ?? null;
  }

  // Live count for the nav badge. Goes through the audited RPC like every
  // other read of patient-linked data — a badge is not a reason to bypass it.
  let queueCount = 0;
  if (staff.siteId) {
    const { data } = await supabase.rpc('list_encounters', { p_site_id: staff.siteId });
    queueCount = (data ?? []).filter(
      (e: { status: string }) => e.status === 'TRIAGE' || e.status === 'IN_CONSULT',
    ).length;
  }

  return (
    <AppShell
      role={staff.role}
      roleLabel={ROLE_LABEL[staff.role] ?? staff.role}
      fullName={staff.fullName}
      email={staff.email}
      siteName={siteName}
      queueCount={queueCount}
    >
      {children}
    </AppShell>
  );
}
