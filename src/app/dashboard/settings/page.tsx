import { requireRole } from '@/lib/require-role';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { SettingsBoard, type StaffRow, type ModuleRow } from './SettingsBoard';

/**
 * Settings — the writes the clinic needs to own.
 *
 * ADMIN only, here and again in every RPC behind it.
 *
 * Until this screen existed, onboarding a nurse or recording a practitioner
 * licence meant someone editing the database by hand. That is not a workflow,
 * it is a dependency — and raw SQL writes no audit entry, so the most sensitive
 * changes in the system were the only ones leaving no trace. Everything here
 * records who did it.
 */
export default async function SettingsPage() {
  await requireRole('ADMIN');
  const staff = await requireStaffContext();
  const supabase = await supabaseServer();

  const [{ data: staffData, error }, { data: moduleData }] = await Promise.all([
    supabase.rpc('list_staff'),
    staff.siteId
      ? supabase.rpc('list_service_modules', { p_site_id: staff.siteId })
      : Promise.resolve({ data: [] }),
  ]);

  const people = (staffData ?? []) as StaffRow[];
  const modules = (moduleData ?? []) as ModuleRow[];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Staff, practitioner licences and which service modules this facility runs.
          Every change here is recorded in the audit log.
        </p>
      </header>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={`Could not load staff: ${error.message}`} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Staff"
          subtitle={`${people.filter((p) => p.active).length} active · ${people.length} total`}
        />
        <CardBody className="pt-0">
          <SettingsBoard staff={people} modules={modules} siteId={staff.siteId ?? null} />
        </CardBody>
      </Card>
    </div>
  );
}
