import { ScrollText, Eye, PencilLine, Users2 } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { requireRole } from '@/lib/require-role';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { AuditEntry } from '@/lib/audit';
import { AuditBoard, type FilterOptions } from './AuditBoard';

interface Summary {
  total: number; reads: number; writes: number;
  actors: number; patients_touched: number;
  oldest: string | null; newest: string | null;
}

/**
 * The audit log.
 *
 * ADMIN and AUDITOR only — enforced here so the page does not render, and again
 * inside list_audit_log() so the data cannot be fetched even if it did.
 *
 * This screen exists because a log nobody reads is not a control. Everything
 * the clinic's RPCs have recorded since the system went up is here, including
 * this visit: reading the audit trail is itself audited, so your own arrival
 * appears at the top of the list next time.
 */
export default async function AuditPage() {
  await requireRole('ADMIN', 'AUDITOR');
  const staff = await requireStaffContext();
  const supabase = await supabaseServer();

  const [{ data: rows, error }, { data: sumData }, { data: optData }] = await Promise.all([
    supabase.rpc('list_audit_log', { p_limit: 200 }),
    supabase.rpc('audit_summary', {}),
    supabase.rpc('audit_filter_options'),
  ]);

  const entries = (rows ?? []) as AuditEntry[];
  const summary = (Array.isArray(sumData) ? sumData[0] : sumData) as Summary | null;
  const options = (optData ?? { actors: [], actions: [], tables: [] }) as FilterOptions;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Audit log</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Every read and write the system records, oldest kept forever. Append-only —
          nothing here can be edited or deleted, including by an administrator.
        </p>
      </header>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={`Could not load the audit log: ${error.message}`} />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Entries recorded"
          value={summary?.total ?? 0}
          icon={ScrollText}
          footnote={
            summary?.oldest
              ? `since ${new Date(summary.oldest).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })}`
              : 'nothing recorded yet'
          }
        />
        <StatTile label="Record views" value={summary?.reads ?? 0} icon={Eye} footnote="Who opened what" />
        <StatTile label="Changes" value={summary?.writes ?? 0} icon={PencilLine} footnote="Created, changed or removed" />
        <StatTile
          label="Staff active in the log"
          value={summary?.actors ?? 0}
          icon={Users2}
          footnote={`${summary?.patients_touched ?? 0} patient record${(summary?.patients_touched ?? 0) === 1 ? '' : 's'} touched`}
        />
      </div>

      <Card>
        <CardHeader
          title="Entries"
          subtitle={
            entries.length === 0
              ? 'Nothing recorded yet'
              : `${entries.length} most recent${entries.length === 200 ? ' (narrow the filters to see further back)' : ''}`
          }
        />
        <CardBody className="pt-0">
          <AuditBoard
            initial={entries}
            options={options}
            canSeeEverything={staff.role === 'ADMIN' || staff.role === 'AUDITOR'}
          />
        </CardBody>
      </Card>
    </div>
  );
}
