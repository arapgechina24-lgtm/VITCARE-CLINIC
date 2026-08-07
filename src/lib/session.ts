import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';

export interface StaffContext {
  userId: string;
  fullName: string;
  role: string;
  email: string;
  siteId: string | null;
}

/** Server Component helper: loads the signed-in staff member's profile + primary site.
 *  Redirects to /login if there's no session (defense in depth — src/proxy.ts already
 *  gates /dashboard/:path*, this covers any route added outside that tree later). */
export async function requireStaffContext(): Promise<StaffContext> {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // `active` is checked here for the same reason api-auth.ts checks it: a
  // deactivated account may still hold a valid, auto-refreshing Supabase
  // session, so the row in `users` is the only thing that can turn them away.
  // Without this an offboarded staff member kept the entire dashboard.
  const { data: profile } = await supabase
    .from('users')
    .select('full_name, role, active')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !profile.active) redirect('/login');

  const { data: membership } = await supabase
    .from('user_site_memberships')
    .select('site_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  return {
    userId: user.id,
    fullName: profile.full_name,
    role: profile.role,
    email: user.email ?? '',
    siteId: membership?.site_id ?? null,
  };
}
