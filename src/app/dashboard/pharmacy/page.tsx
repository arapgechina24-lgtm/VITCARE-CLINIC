import { AlertTriangle, PackageCheck, Pill, SendHorizonal } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { CAN } from '@/lib/roles';
import { pharmacyStats, type PharmacyRow } from '@/lib/pharmacy';
import { PharmacyBoard } from './PharmacyBoard';

interface LinkHealth {
  queued: number;
  retrying: number;
  failed: number;
  delivered_today: number;
  oldest_undelivered_at: string | null;
}

/**
 * Pharmacy — the clinic's view of where each prescription has got to.
 *
 * Read-mostly by design. VITCARE-POS dispenses; this screen exists so the
 * clinic can answer "did my patient get their medicine?" without ringing the
 * till, and so a broken CLINIC → POS link is visible as a number rather than
 * discovered when a patient comes back empty-handed.
 */
export default async function PharmacyPage() {
  const staff = await requireStaffContext();

  if (!staff.siteId) {
    return (
      <Card>
        <CardBody className="pt-5">
          <p className="text-sm text-ink-secondary">
            Your account isn&apos;t assigned to a site yet — ask an administrator to add you to one.
          </p>
        </CardBody>
      </Card>
    );
  }

  const supabase = await supabaseServer();
  const showHealth = CAN.pharmacyLinkHealth(staff.role);

  const [{ data, error }, healthRes] = await Promise.all([
    supabase.rpc('list_pharmacy_queue', { p_site_id: staff.siteId, p_include_closed: false }),
    // pharmacy_link_health throws for anyone else, so it is not even called —
    // a 'not authorized' in the network tab of a nurse's browser is noise that
    // looks like a bug.
    showHealth
      ? supabase.rpc('pharmacy_link_health', { p_site_id: staff.siteId })
      : Promise.resolve({ data: null }),
  ]);

  const rows = (data ?? []) as PharmacyRow[];
  const stats = pharmacyStats(rows);
  const health = (Array.isArray(healthRes?.data) ? healthRes.data[0] : healthRes?.data) as LinkHealth | null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Pharmacy</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Prescriptions sent to the pharmacy till. Dispensing happens in the pharmacy system.
        </p>
      </header>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={`Could not load the queue: ${error.message}`} />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open prescriptions"
          value={stats.open}
          icon={Pill}
          footnote={stats.open === 0 ? 'Nothing outstanding' : `${stats.awaitingPharmacy} awaiting the pharmacy`}
        />
        <StatTile
          label="Ready to collect"
          value={stats.readyToCollect}
          icon={PackageCheck}
          footnote="Dispensed, not yet handed over"
        />
        <StatTile
          label="Out of stock"
          value={stats.outOfStock}
          icon={AlertTriangle}
          higherIsBetter={false}
          footnote={stats.outOfStock === 0 ? 'Everything fillable' : 'Needs a clinical decision'}
        />
        <StatTile
          label="Never reached the till"
          value={stats.undelivered}
          icon={SendHorizonal}
          higherIsBetter={false}
          footnote={
            stats.undelivered === 0
              ? 'Every prescription delivered'
              : 'The link to the pharmacy needs attention'
          }
        />
      </div>

      {showHealth && health && (health.failed > 0 || health.queued > 0 || health.retrying > 0) && (
        <Card>
          <CardHeader
            title="Delivery link"
            subtitle="CLINIC → POS outbox. Only administrators and auditors see this."
          />
          <CardBody className="pt-0">
            <div className="flex flex-wrap gap-2">
              {health.queued > 0 && <StatusBadge tone="neutral" label={`${health.queued} queued`} />}
              {health.retrying > 0 && <StatusBadge tone="warning" label={`${health.retrying} retrying`} />}
              {health.failed > 0 && <StatusBadge tone="critical" label={`${health.failed} failed`} />}
              <StatusBadge tone="good" label={`${health.delivered_today} delivered today`} />
            </div>
            {health.oldest_undelivered_at && (
              <p className="mt-3 text-xs text-ink-secondary">
                Oldest undelivered prescription was queued{' '}
                {new Date(health.oldest_undelivered_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}.
                If that is not moving, the outbox drain is not running.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Prescription queue"
          subtitle={rows.length === 0 ? 'Nothing outstanding' : `${rows.length} open`}
        />
        <CardBody className="pt-0">
          <PharmacyBoard
            rows={rows}
            canCancel={CAN.cancelPrescription(staff.role)}
            showDiagnostics={showHealth}
          />
        </CardBody>
      </Card>
    </div>
  );
}
