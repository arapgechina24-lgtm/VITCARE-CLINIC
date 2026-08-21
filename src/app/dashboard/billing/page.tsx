import { Banknote, FileText, Receipt, Wallet } from 'lucide-react';
import { requireStaffContext } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatTile } from '@/components/ui/StatTile';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { CAN } from '@/lib/roles';
import { formatKes, type InvoiceSummary } from '@/lib/billing';
import { isConditional, type CatalogueService } from '@/lib/catalogue';
import { BillingBoard } from './BillingBoard';

interface DaySummary {
  invoiced_cents: number;
  collected_cents: number;
  outstanding_cents: number;
  invoice_count: number;
  unpaid_count: number;
}

/**
 * Billing — clinic services only.
 *
 * Medicines are priced, dispensed and paid for in VITCARE-POS on a KRA-fiscal
 * receipt. This screen never charges for them; where a visit also has a
 * prescription, the invoice shows the pharmacy figure beside its own total,
 * clearly attributed, and never adds the two together.
 */
export default async function BillingPage() {
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
  const [{ data: invData, error }, { data: sumData }, { data: svcData }] = await Promise.all([
    supabase.rpc('list_invoices', { p_site_id: staff.siteId, p_status: null, p_limit: 100 }),
    supabase.rpc('billing_day_summary', { p_site_id: staff.siteId, p_day: null }),
    // Fetched once at the cash rate, but carrying BOTH price columns and the
    // SHA status, so the board can re-price the picker for whichever payer an
    // invoice has without another round trip. See src/lib/catalogue.ts.
    //
    // Inactive services are included DELIBERATELY. The desk needs to find out
    // that an X-ray exists but is switched off — "Not available here, the
    // Radiology module is not active" is an answer it can give the patient,
    // where an empty search result is not. They come back greyed out, with the
    // add button disabled and the reason on the line.
    supabase.rpc('list_service_catalog', {
      p_site_id: staff.siteId, p_payer: 'CASH', p_include_inactive: true,
    }),
  ]);

  const invoices = (invData ?? []) as InvoiceSummary[];
  const services = (svcData ?? []) as CatalogueService[];
  const chargeableNow = services.filter((s) => s.chargeable).length;
  const pendingModules = new Set(
    services.filter((s) => isConditional(s.module)).map((s) => s.module),
  );
  const summary = (Array.isArray(sumData) ? sumData[0] : sumData) as DaySummary | null;

  const collected = summary?.collected_cents ?? 0;
  const invoiced = summary?.invoiced_cents ?? 0;
  const outstanding = summary?.outstanding_cents ?? 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Billing</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Clinic services. Medicines are billed at the pharmacy till.
        </p>
      </header>

      {error && (
        <Card>
          <CardBody className="pt-5">
            <StatusBadge tone="critical" label={`Could not load invoices: ${error.message}`} />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Invoiced today"
          value={formatKes(invoiced)}
          icon={FileText}
          footnote={`${summary?.invoice_count ?? 0} invoice${(summary?.invoice_count ?? 0) === 1 ? '' : 's'} issued`}
        />
        <StatTile
          label="Collected today"
          value={formatKes(collected)}
          icon={Banknote}
          footnote="Cash, M-Pesa, insurer and waivers"
        />
        <StatTile
          label="Outstanding"
          value={formatKes(outstanding)}
          icon={Wallet}
          higherIsBetter={false}
          footnote={`${summary?.unpaid_count ?? 0} invoice${(summary?.unpaid_count ?? 0) === 1 ? '' : 's'} still owing`}
        />
        <StatTile
          label="Chargeable services"
          value={chargeableNow}
          icon={Receipt}
          footnote={
            services.length === 0
              ? 'No catalogue yet — an admin adds services'
              : chargeableNow === services.length
                ? `${services.length} in the catalogue`
                : `of ${services.length} in the catalogue`
          }
        />
      </div>

      {services.length === 0 ? (
        <Card>
          <CardBody className="pt-5">
            <p className="text-sm text-ink-secondary">
              There are no priced services for this site yet, so nothing can be charged. An
              administrator adds them to the service catalogue — a code, a name, a price in
              shillings and whether the item is VAT-standard or exempt.
            </p>
          </CardBody>
        </Card>
      ) : chargeableNow === 0 ? (
        <Card>
          <CardBody className="pt-5">
            <p className="text-sm text-ink-secondary">
              The catalogue is loaded but nothing can be charged from it yet — every price
              takes effect on a date that has not arrived. This is deliberate: catalogue v1.0
              is dated 01 September 2026 and marked draft pending board approval, and billing
              an unapproved price is worse than not billing at all. An administrator brings
              the date forward once the board has ratified it.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {pendingModules.size > 0 && (
        <Card>
          <CardBody className="pt-5">
            <p className="text-sm text-ink-secondary">
              {pendingModules.size} service module
              {pendingModules.size === 1 ? ' is' : 's are'} loaded but switched off, so
              nothing in {pendingModules.size === 1 ? 'it' : 'them'} can be billed:{' '}
              {[...pendingModules].map((m) => m.replace('Conditional - ', '')).sort().join(', ')}.
              Each needs its licence, equipment and registered staff in place before an
              administrator activates it.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Invoices"
          subtitle={invoices.length === 0 ? 'Nothing raised yet' : `${invoices.length} most recent`}
        />
        <CardBody className="pt-0">
          <BillingBoard
            invoices={invoices}
            services={services}
            canBill={CAN.bill(staff.role)}
            canVoid={CAN.voidInvoice(staff.role)}
          />
        </CardBody>
      </Card>
    </div>
  );
}
