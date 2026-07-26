import Link from 'next/link';
import { requireStaffContext } from '@/lib/session';
import SignOutButton from './SignOutButton';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaffContext();

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink/10 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="font-display font-bold text-clinic-deep">Vitcare Clinic</Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/dashboard" className="hover:underline">Queue</Link>
            {(staff.role === 'RECEPTIONIST' || staff.role === 'NURSE' || staff.role === 'ADMIN') && (
              <Link href="/dashboard/register" className="hover:underline">Register</Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-ink/60">
          <span>{staff.fullName} · {staff.role}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="p-4 max-w-4xl mx-auto">{children}</main>
    </div>
  );
}
