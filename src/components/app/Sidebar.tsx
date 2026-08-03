'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  Activity, CalendarDays, LayoutDashboard, Pill, Receipt, Settings, Users, UserPlus, X,
} from 'lucide-react';

/**
 * Primary navigation.
 *
 * `built: false` marks a destination whose backend does not exist yet. It is
 * shown, because hiding roadmap sections makes a system feel smaller than it
 * is — but it carries a visible "Soon" chip so nobody clicks expecting real
 * patient data and finds mock rows. Pretending unbuilt features are live is
 * how demos become clinical incidents.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  built: boolean;
  /** Only render for these clinic roles. Undefined = everyone. */
  roles?: string[];
  badge?: number;
}

export const NAV_SECTIONS: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: 'Clinical',
    items: [
      { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, built: true },
      { href: '/dashboard/patients', label: 'Patients', icon: Users, built: false },
      {
        href: '/dashboard/register',
        label: 'Register patient',
        icon: UserPlus,
        built: true,
        roles: ['RECEPTIONIST', 'NURSE', 'ADMIN'],
      },
      { href: '/dashboard/appointments', label: 'Appointments', icon: CalendarDays, built: false },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { href: '/dashboard/pharmacy', label: 'Pharmacy', icon: Pill, built: false },
      { href: '/dashboard/billing', label: 'Billing', icon: Receipt, built: false },
    ],
  },
  {
    heading: 'Administration',
    items: [{ href: '/dashboard/settings', label: 'Settings', icon: Settings, built: false }],
  },
];

export function Sidebar({
  role,
  siteName,
  queueCount,
  onNavigate,
  onClose,
}: {
  role: string;
  siteName: string | null;
  queueCount: number;
  onNavigate?: () => void;
  /** Present only in the mobile drawer. */
  onClose?: () => void;
}) {
  const path = usePathname();

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Brand */}
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-line px-5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white">
          <Activity className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight text-ink">Vitcare Clinic</p>
          {siteName && <p className="truncate text-2xs text-ink-muted" title={siteName}>{siteName}</p>}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-muted hover:bg-surface-hover lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter((i) => !i.roles || i.roles.includes(role));
          if (visible.length === 0) return null;
          return (
            <div key={section.heading} className="mb-5 last:mb-0">
              <p className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                {section.heading}
              </p>
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const active = path === item.href;
                  const Icon = item.icon;
                  const badge = item.href === '/dashboard' ? queueCount : item.badge;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? 'page' : undefined}
                        className={`group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors ${
                          active
                            ? 'bg-brand-wash font-medium text-brand-ink'
                            : 'text-ink-secondary hover:bg-surface-hover hover:text-ink'
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="flex-1 truncate">{item.label}</span>

                        {!item.built && (
                          <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-2xs font-medium text-ink-muted">
                            Soon
                          </span>
                        )}
                        {item.built && typeof badge === 'number' && badge > 0 && (
                          <span className="tabular shrink-0 rounded-full bg-brand px-1.5 py-0.5 text-2xs font-semibold text-white">
                            {badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
