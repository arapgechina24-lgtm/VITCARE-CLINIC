import { Building2 } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { requireRole } from '@/lib/require-role';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { Scheme, SchemeUtilisation, SchemeStatement } from '@/lib/schemes';
import { SchemeBoard } from './SchemeBoard';

/**
 * Corporate schemes — Stokman Rozen Kenya and La Pieve.
 *
 * Replaces two hand-kept workbooks. What the screen is for, in order of how
 * often it is needed:
 *
 *   1. POST TODAY'S VISITS. The desk sees the member, the household, and what
 *      is left of the farm's month before it charges anything.
 *   2. WATCH THE MONTH. Spend against the agreed ceiling, split into the same
 *      four columns the farms' own sheets use, so the two reconcile.
 *   3. ENROL PEOPLE. Employees and their dependants, with a cover window.
 *   4. INVOICE. Build, download and issue the month.
 *
 * The role gate is here so the page does not render, and again inside every
 * RPC so the data cannot be fetched even if it did. AUDITOR is included because
 * reviewing what a customer was charged is the point of the role; what an
 * auditor CAN do is narrower, and each RPC enforces that separately.
 */
export default async function SchemesPage() {
  await requireRole('ADMIN', 'RECEPTIONIST', 'AUDITOR');
  const staff = await requireStaffContext();
  const supabase = await supabaseServer();

  if (!staff.siteId) {
    return (
      <Card>
        <CardBody className="pt-5">
          <StatusBadge
            tone="critical"
            label="Your account is not attached to a site, so no scheme can be shown. An administrator can fix this in Settings."
          />
        </CardBody>
      </Card>
    );
  }

  const [{ data: schemeData, error }, { data: utilData }, { data: stmtData }, { data: pendingData }] =
    await Promise.all([
      supabase.rpc('list_schemes', { p_site_id: staff.siteId, p_include_inactive: true }),
      supabase.rpc('scheme_utilisation', { p_site_id: staff.siteId }),
      supabase.rpc('list_scheme_statements', { p_site_id: staff.siteId, p_limit: 24 }),
      supabase.rpc('scheme_periods_awaiting_statement', { p_site_id: staff.siteId }),
    ]);

  const schemes = (schemeData ?? []) as Scheme[];
  const utilisation = (utilData ?? []) as SchemeUtilisation[];
  const statements = (stmtData ?? []) as SchemeStatement[];
  const awaiting = (pendingData ?? []) as Array<{
    scheme_id: string; code: string; name: string; period: string;
    visits: number; total_cents: number;
    statement_id: string | null; statement_status: string | null;
  }>;

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-wash text-brand-ink">
          <Building2 className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Corporate schemes</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Employees and dependants of the farms we serve on account. Every visit is
            priced as it is recorded, and the month is tracked against the limit agreed
            with each company.
          </p>
        </div>
      </header>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={`Could not load the schemes: ${error.message}`} />
          </CardBody>
        </Card>
      )}

      <SchemeBoard
        role={staff.role}
        siteId={staff.siteId}
        schemes={schemes}
        utilisation={utilisation}
        statements={statements}
        awaiting={awaiting}
      />
    </div>
  );
}
