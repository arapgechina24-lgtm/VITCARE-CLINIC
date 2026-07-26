import { requireStaffContext } from '@/lib/session';
import RegisterForm from './RegisterForm';

export default async function RegisterPage() {
  const staff = await requireStaffContext();

  return (
    <div className="max-w-md">
      <h1 className="font-display text-xl font-bold mb-4">Register patient</h1>
      {staff.siteId ? (
        <RegisterForm siteId={staff.siteId} />
      ) : (
        <p className="text-alert text-sm">Your account isn&apos;t assigned to a site yet — ask an admin to add a row to user_site_memberships.</p>
      )}
    </div>
  );
}
