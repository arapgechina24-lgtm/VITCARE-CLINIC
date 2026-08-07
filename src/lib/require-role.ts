import { redirect } from 'next/navigation';
import { requireStaffContext, type StaffContext } from './session';

/**
 * Server Component guard: a session AND one of the listed roles.
 *
 * The triage, consult and prescribe pages had no role check at all — only the
 * session gate in proxy.ts — so any signed-in employee could open them. The
 * database refused their writes, but the page still rendered and still fetched
 * the patient's chart on the way.
 *
 * Redirects rather than rendering a "denied" screen: telling someone which
 * URLs exist but are closed to them is a map of the system they are not
 * supposed to have. `/dashboard` is where they belong.
 */
export async function requireRole(...allowed: string[]): Promise<StaffContext> {
  const staff = await requireStaffContext();
  if (!allowed.includes(staff.role)) redirect('/dashboard');
  return staff;
}
