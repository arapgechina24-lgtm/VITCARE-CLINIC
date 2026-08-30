import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import RegisterForm from './RegisterForm';
import CheckInForm from './CheckInForm';
import type { Scheme } from '@/lib/schemes';

export default async function RegisterPage() {
  const staff = await requireStaffContext();

  // Ordered so the commoner act is first: most people arriving at the desk have
  // been here before, and every corporate member has by definition.
  const { data: schemeRows } = staff.siteId
    ? await (await supabaseServer()).rpc('list_schemes', { p_site_id: staff.siteId })
    : { data: [] };

  return (
    <div className="max-w-md space-y-8">
      <div>
        <h1 className="font-display text-xl font-bold mb-1">Start a visit</h1>
        <p className="mb-4 text-sm text-ink-secondary">
          Someone the clinic already knows — including anyone on a company account.
        </p>
        {staff.siteId ? (
          <CheckInForm siteId={staff.siteId} schemes={(schemeRows ?? []) as Scheme[]} />
        ) : (
          <p className="text-alert text-sm">
            Your account isn&apos;t assigned to a site yet — ask an admin to add a row to
            user_site_memberships.
          </p>
        )}
      </div>

      <div className="border-t border-line pt-6">
        <h2 className="font-display text-lg font-bold mb-1">Register a new patient</h2>
        <p className="mb-4 text-sm text-ink-secondary">
          Only for someone with no record here yet. Registering an existing patient again
          creates a second file under a new MRN.
        </p>
        {staff.siteId && <RegisterForm siteId={staff.siteId} />}
      </div>
    </div>
  );
}
