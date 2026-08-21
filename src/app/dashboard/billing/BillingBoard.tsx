'use client';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge';
import {
  INVOICE_STATUS_LABEL, canEditCharges, canIssue, canTakePayment, canVoid,
  formatKes, lineSubtotalCents, lineVatCents, outstandingCents, parseKesToCents,
  type InvoiceItemRow, type InvoiceStatus, type InvoiceSummary, type PaymentMethod,
  type PaymentRow,
} from '@/lib/billing';
import { clinicDateKey } from '@/lib/appointments';
import {
  PAYER_LABEL, PRICE_BASIS_LABEL, chargeBlockReason, groupByCategory,
  priceForPayer, searchServices,
  type CatalogueService, type Payer,
} from '@/lib/catalogue';

const TONE: Record<InvoiceStatus, StatusTone> = {
  DRAFT: 'neutral',
  ISSUED: 'warning',
  PART_PAID: 'warning',
  PAID: 'good',
  VOID: 'neutral',
};

interface InvoiceDetail {
  invoice: InvoiceSummary & {
    subtotal_cents: number; vat_cents: number; insurer_code: string | null; void_reason: string | null;
  };
  patient: { id: string; full_name: string; mrn: string; phone: string | null };
  items: InvoiceItemRow[];
  payments: PaymentRow[];
  pharmacy: Array<{ id: string; status: string; total_amount_cents: number | null }>;
}

export function BillingBoard({
  invoices,
  services,
  canBill,
  canVoid: mayVoid,
}: {
  invoices: InvoiceSummary[];
  services: CatalogueService[];
  canBill: boolean;
  canVoid: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(id: string) {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc('get_invoice', { p_invoice_id: id });
    setBusy(false);
    if (error) return setError(error.message);
    setDetail(data as InvoiceDetail);
    setOpenId(id);
  }

  /** Every mutation: run it, surface the server's message verbatim on failure,
   *  then reload the document AND the list. The RPCs phrase their errors as
   *  instructions ("issue the invoice before taking payment"), so passing them
   *  straight through is the right call. */
  async function mutate(id: string, fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return setError(error.message);
    await load(id);
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-critical-wash px-3 py-2">
          <p className="text-xs text-critical-ink">{error}</p>
        </div>
      )}

      {invoices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong py-10 text-center">
          <p className="text-sm text-ink-secondary">No invoices yet.</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            An invoice is raised against a visit from the patient&apos;s record.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {invoices.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => (openId === i.id ? setOpenId(null) : load(i.id))}
                className="-mx-2 flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-surface-hover"
              >
                <span className="tabular w-[132px] shrink-0 text-xs text-ink-secondary">
                  {i.invoice_no ?? <span className="text-ink-muted">draft</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{i.patient_full_name}</span>
                  <span className="block truncate text-xs text-ink-muted tabular">{i.patient_mrn}</span>
                </span>
                <span className="tabular shrink-0 text-right text-sm text-ink">
                  {formatKes(i.total_cents)}
                  {outstandingCents(i) > 0 && i.status !== 'DRAFT' && (
                    <span className="block text-2xs text-critical-ink">
                      {formatKes(outstandingCents(i))} owing
                    </span>
                  )}
                </span>
                <StatusBadge tone={TONE[i.status]} label={INVOICE_STATUS_LABEL[i.status]} />
              </button>

              {openId === i.id && detail && (
                <InvoicePanel
                  detail={detail}
                  services={services}
                  canBill={canBill}
                  canVoid={mayVoid}
                  busy={busy}
                  onMutate={(fn) => mutate(i.id, fn)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InvoicePanel({
  detail, services, canBill, canVoid: mayVoid, busy, onMutate,
}: {
  detail: InvoiceDetail;
  services: CatalogueService[];
  canBill: boolean;
  canVoid: boolean;
  busy: boolean;
  onMutate: (fn: () => PromiseLike<{ error: { message: string } | null }>) => void;
}) {
  const inv = detail.invoice;
  const [query, setQuery] = useState('');
  const [qty, setQty] = useState(1);
  const [payMethod, setPayMethod] = useState<PaymentMethod>('CASH');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  // Seeded from the document, not defaulted to CASH: this control CHANGES the
  // invoice's payer, so showing anything other than what it currently is would
  // invite a cashier to "confirm" a value that is not in force.
  const [insurer, setInsurer] = useState(inv.insurer_code ?? '');
  const [voidReason, setVoidReason] = useState('');
  const [pulled, setPulled] = useState<string | null>(null);

  const today = useMemo(() => clinicDateKey(), []);
  const outstanding = outstandingCents(inv);

  // Priced for THIS invoice's payer, client-side. The catalogue arrives once
  // with both columns and the SHA status, so switching payer re-prices the
  // picker without a round trip — and the figures match what add_invoice_item
  // will store, because both run the same rule (see src/lib/catalogue.ts).
  const matches = useMemo(() => {
    if (query.trim() === '') return [];
    return groupByCategory(searchServices(services, query).slice(0, 40));
  }, [services, query]);

  function setPayer(next: Payer, code: string) {
    onMutate(() => supabase.rpc('set_invoice_payer', {
      p_invoice_id: inv.id, p_payer: next, p_insurer_code: code || null,
    }));
  }
  const payCents = parseKesToCents(payAmount);
  // The server refuses an overpayment; catching it here means the cashier is
  // told before they take the money, not after.
  const payTooMuch = payCents != null && payCents > outstanding;

  return (
    <div className="mb-3 rounded-lg border border-line bg-surface-sunken p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
        <span className="font-medium text-ink">{detail.patient.full_name}</span>
        <span className="tabular">{detail.patient.mrn}</span>
        <span>{PAYER_LABEL[inv.payer]}{inv.insurer_code ? ` · ${inv.insurer_code}` : ''}</span>
        {inv.void_reason && <span className="text-critical-ink">Voided: {inv.void_reason}</span>}
      </div>

      {/* Charges */}
      {detail.items.length === 0 ? (
        <p className="py-3 text-xs text-ink-muted">No charges on this invoice yet.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="py-1 font-medium">Service</th>
              <th className="py-1 text-right font-medium">Qty</th>
              <th className="py-1 text-right font-medium">Rate</th>
              <th className="py-1 text-right font-medium">VAT</th>
              <th className="py-1 text-right font-medium">Line</th>
              {canBill && canEditCharges(inv.status) && <th className="w-8" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {detail.items.map((it) => (
              <tr key={it.id}>
                <td className="py-1.5 text-ink">
                  {it.description}
                  {/* A zero on an SHA invoice is correct and a zero typed by
                      mistake is not. price_basis is the only thing that tells
                      them apart, so it is on the line, not in a tooltip. */}
                  {it.price_basis !== 'CASH' && (
                    <span className="block text-2xs text-ink-muted">
                      {PRICE_BASIS_LABEL[it.price_basis]}
                    </span>
                  )}
                </td>
                <td className="tabular py-1.5 text-right text-ink-secondary">
                  {it.quantity}
                  {it.unit && (
                    <span className="block text-2xs text-ink-muted">
                      {it.unit.replace(/^Per /, '')}
                    </span>
                  )}
                </td>
                <td className="tabular py-1.5 text-right text-ink-secondary">
                  {formatKes(it.unit_price_cents, { symbol: false })}
                </td>
                <td className="tabular py-1.5 text-right text-ink-secondary">
                  {formatKes(lineVatCents(it), { symbol: false })}
                </td>
                <td className="tabular py-1.5 text-right text-ink">
                  {formatKes(lineSubtotalCents(it) + lineVatCents(it), { symbol: false })}
                </td>
                {canBill && canEditCharges(inv.status) && (
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onMutate(() => supabase.rpc('remove_invoice_item', { p_item_id: it.id }))}
                      className="text-2xs text-ink-muted underline hover:text-critical-ink disabled:opacity-40"
                    >
                      remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Totals — straight from the server, never recomputed here. */}
      <div className="mt-3 space-y-1 border-t border-line pt-2 text-xs">
        <Row label="Subtotal" value={formatKes(inv.subtotal_cents)} />
        <Row label="VAT" value={formatKes(inv.vat_cents)} />
        <Row label="Total" value={formatKes(inv.total_cents)} strong />
        {inv.paid_cents > 0 && <Row label="Paid" value={formatKes(inv.paid_cents)} />}
        {outstanding > 0 && inv.status !== 'DRAFT' && (
          <Row label="Outstanding" value={formatKes(outstanding)} strong />
        )}
      </div>

      {/* POS's figure, never added in. */}
      {detail.pharmacy.length > 0 && (
        <p className="mt-2 rounded-lg bg-surface px-2.5 py-1.5 text-2xs text-ink-muted">
          This visit also has {detail.pharmacy.length} prescription
          {detail.pharmacy.length === 1 ? '' : 's'} at the pharmacy
          {detail.pharmacy.some((p) => p.total_amount_cents != null) && (
            <>
              {' '}totalling{' '}
              {formatKes(detail.pharmacy.reduce((s, p) => s + (p.total_amount_cents ?? 0), 0))}
            </>
          )}
          . Medicines are paid for at the pharmacy till and are not part of this invoice.
        </p>
      )}

      {detail.payments.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-2">
          {detail.payments.map((p) => (
            <li key={p.id} className="flex justify-between text-2xs text-ink-secondary">
              <span>
                {p.method}
                {p.reference ? ` · ${p.reference}` : ''}
                {p.received_by_name ? ` · ${p.received_by_name}` : ''}
              </span>
              <span className="tabular">{formatKes(p.amount_cents)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Actions */}
      {canBill && (
        <div className="mt-4 space-y-3 border-t border-line pt-3">
          {canEditCharges(inv.status) && (
            <>
              {/* WHO IS PAYING comes first, because it decides every price
                  below it. Changing it re-prices the lines already on the
                  draft — the server does that in set_invoice_payer, so the
                  document can never disagree with its own payer field. */}
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1">
                  <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">
                    Who is paying
                  </span>
                  <select
                    aria-label="Payer"
                    value={inv.payer}
                    onChange={(e) => setPayer(e.target.value as Payer, insurer)}
                    disabled={busy}
                    className="w-full min-w-[180px] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink disabled:opacity-40"
                  >
                    <option value="CASH">{PAYER_LABEL.CASH}</option>
                    <option value="SHA">{PAYER_LABEL.SHA}</option>
                    <option value="INSURER">{PAYER_LABEL.INSURER}</option>
                  </select>
                </label>
                {inv.payer === 'INSURER' && (
                  <input
                    aria-label="Insurer code"
                    value={insurer}
                    onChange={(e) => setInsurer(e.target.value)}
                    onBlur={() => insurer !== (inv.insurer_code ?? '') && setPayer('INSURER', insurer)}
                    placeholder="Insurer code"
                    className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
                  />
                )}
                <p className="w-full text-2xs text-ink-muted">
                  {inv.payer === 'CASH' && 'Charged at the cash rate.'}
                  {inv.payer === 'SHA'
                    && 'Services SHA covers are recorded at no charge — the Fund pays by capitation on reported volume. Anything not covered is charged at the cash rate.'}
                  {inv.payer === 'INSURER' && 'Charged at the credit tariff, 20% above cash.'}
                  {' '}Changing this re-prices everything already on the invoice.
                </p>
              </div>

              {/* The bridge from the consulting room. Prices what the clinician
                  recorded, leaves off what must not be charged, and says which
                  is which rather than silently dropping the difference. */}
              {inv.encounter_id && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setPulled(null);
                      const { data, error } = await supabase.rpc(
                        'pull_encounter_services_to_invoice', { p_invoice_id: inv.id },
                      );
                      if (error) return;
                      const r = (Array.isArray(data) ? data[0] : data) as
                        { added: number; skipped: number } | null;
                      setPulled(
                        r == null ? null
                          : r.added === 0 && r.skipped === 0
                            ? 'Nothing recorded for this visit yet.'
                            : `${r.added} charge${r.added === 1 ? '' : 's'} added`
                              + (r.skipped > 0
                                ? `, ${r.skipped} recorded but not chargeable.`
                                : '.'),
                      );
                      onMutate(async () => ({ error: null }));
                    }}
                    className="rounded-lg border border-line px-3 py-2 text-xs text-ink-secondary hover:bg-surface disabled:opacity-40"
                  >
                    Bill what was done at this visit
                  </button>
                  {pulled && <p className="text-2xs text-ink-muted">{pulled}</p>}
                </div>
              )}

              {/* Anything else — 237 services is a search box, not a dropdown. */}
              <div>
                <div className="flex flex-wrap items-end gap-2">
                  <input
                    aria-label="Find a service"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Add another charge — dressing, urine culture, LAB-MIC-005…"
                    className="min-w-[220px] flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted"
                  />
                  <input
                    aria-label="Quantity"
                    type="number"
                    min={1}
                    value={qty}
                    onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                    className="w-20 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
                  />
                </div>

                {query.trim() !== '' && matches.length === 0 && (
                  <p className="mt-2 text-xs text-ink-muted">Nothing matches “{query}”.</p>
                )}

                {matches.map(([category, rows]) => (
                  <div key={category} className="mt-3">
                    <p className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
                      {category}
                    </p>
                    <ul className="mt-1 divide-y divide-line">
                      {rows.map((svc) => {
                        // The same three refusals add_invoice_item applies,
                        // shown BEFORE the click. The server still decides —
                        // this only spares the desk discovering it from an
                        // error with a patient waiting.
                        const blocked = chargeBlockReason(svc, today);
                        const price = priceForPayer(
                          inv.payer, svc.sha_phc_status,
                          svc.cash_price_cents, svc.insurance_price_cents,
                        );
                        return (
                          <li key={svc.id} className="flex items-center gap-3 py-1.5">
                            <button
                              type="button"
                              disabled={busy || blocked !== null}
                              onClick={() => onMutate(() =>
                                supabase.rpc('add_invoice_item', {
                                  p_invoice_id: inv.id, p_service_id: svc.id, p_quantity: qty,
                                }))}
                              className="min-w-0 flex-1 text-left disabled:opacity-40"
                            >
                              <span className="block truncate text-sm text-ink">{svc.name}</span>
                              <span className="block truncate text-2xs text-ink-muted tabular">
                                {svc.code}{svc.unit ? ` · ${svc.unit}` : ''}
                                {blocked ? ` · ${blocked}` : ''}
                              </span>
                            </button>
                            <span className="tabular shrink-0 text-xs text-ink-secondary">
                              {blocked ? '—' : formatKes(price)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          )}

          {canIssue(inv.status, detail.items.length) && (
            <div className="flex flex-wrap items-end gap-2">
              {/* No payer control here any more. It was asked for at this point
                  in 0021 — AFTER every line had been priced — which let an
                  insurer be invoiced at cash rates with the document's own
                  payer field saying otherwise. It now belongs to the invoice
                  from the moment it is opened. */}
              <button
                type="button"
                disabled={busy}
                onClick={() => onMutate(() =>
                  supabase.rpc('issue_invoice', { p_invoice_id: inv.id }))}
                className="rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-40"
              >
                Issue invoice · {formatKes(inv.total_cents)}
              </button>
              <p className="w-full text-2xs text-ink-muted">
                Issuing assigns the number and freezes the charges at the{' '}
                {PAYER_LABEL[inv.payer].toLowerCase()} rate. Not a fiscal receipt — eTIMS
                is handled by the pharmacy system.
              </p>
            </div>
          )}

          {canTakePayment(inv) && (
            <div className="flex flex-wrap items-end gap-2">
              <select
                aria-label="Payment method"
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="CASH">Cash</option>
                <option value="MPESA">M-Pesa</option>
                <option value="INSURER">Insurer</option>
                <option value="WAIVER">Waiver</option>
              </select>
              <input
                aria-label="Amount"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                placeholder={formatKes(outstanding, { symbol: false })}
                className="w-32 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              {payMethod === 'MPESA' && (
                <input
                  aria-label="M-Pesa reference"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="Reference"
                  className="w-36 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
              )}
              <button
                type="button"
                disabled={busy || payCents == null || payCents <= 0 || payTooMuch}
                onClick={() => onMutate(() =>
                  supabase.rpc('record_payment', {
                    p_invoice_id: inv.id, p_method: payMethod,
                    p_amount_cents: payCents, p_reference: payRef || null,
                  }))}
                className="rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-40"
              >
                Record payment
              </button>
              {payAmount !== '' && payCents == null && (
                <p className="w-full text-2xs text-critical-ink">
                  Enter an amount in shillings, e.g. 1500 or 1500.50.
                </p>
              )}
              {payTooMuch && (
                <p className="w-full text-2xs text-critical-ink">
                  That is more than the {formatKes(outstanding)} outstanding.
                </p>
              )}
            </div>
          )}

          {mayVoid && canVoid(inv) && (
            <div className="flex flex-wrap items-end gap-2">
              <input
                aria-label="Void reason"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="Reason for voiding"
                className="min-w-[200px] flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              <button
                type="button"
                disabled={busy || voidReason.trim().length === 0}
                onClick={() => onMutate(() =>
                  supabase.rpc('void_invoice', { p_invoice_id: inv.id, p_reason: voidReason.trim() }))}
                className="rounded-lg border border-critical/40 px-3 py-2 text-xs text-critical-ink hover:bg-critical-wash disabled:opacity-40"
              >
                Void invoice
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={strong ? 'font-medium text-ink' : 'text-ink-secondary'}>{label}</span>
      <span className={`tabular ${strong ? 'font-medium text-ink' : 'text-ink-secondary'}`}>{value}</span>
    </div>
  );
}
