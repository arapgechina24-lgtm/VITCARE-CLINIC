'use client';
import { useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';

/**
 * The frame every dashboard page renders inside.
 *
 * Layout: a fixed 260px rail on desktop, an overlay drawer below `lg`. The
 * main column scrolls independently so the nav and header never leave — on a
 * clinic workstation the queue is the thing you come back to constantly, and
 * scrolling the whole page to reach it wastes real time.
 *
 * Client component only because of the drawer's open/closed state; every page
 * rendered as `children` stays a server component and keeps fetching on the
 * server, which is what keeps patient data off the client bundle.
 */
export function AppShell({
  children,
  role,
  roleLabel,
  fullName,
  email,
  siteName,
  queueCount,
}: {
  children: ReactNode;
  role: string;
  roleLabel: string;
  fullName: string;
  email: string;
  siteName: string | null;
  queueCount: number;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-dvh bg-page">
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] border-r border-line lg:block">
        <Sidebar role={role} siteName={siteName} queueCount={queueCount} />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
          />
          <div className="absolute inset-y-0 left-0 w-[280px] shadow-lg">
            <Sidebar
              role={role}
              siteName={siteName}
              queueCount={queueCount}
              onNavigate={() => setDrawerOpen(false)}
              onClose={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="lg:pl-[260px]">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md sm:px-6">
          <button
            onClick={() => setDrawerOpen(true)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-secondary hover:bg-surface-hover lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>

          <div className="min-w-0 flex-1" />

          <UserMenu fullName={fullName} email={email} roleLabel={roleLabel} />
        </header>

        <main className="animate-rise px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
