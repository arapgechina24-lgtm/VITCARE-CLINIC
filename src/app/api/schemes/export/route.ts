/**
 * Scheme statement and register downloads.
 *
 * One handler for both formats and every range, because the two exports must
 * report the SAME figures. Two endpoints reading the data two ways is how a
 * workbook and a PDF end up disagreeing about a month, and the farm's finance
 * office is the one that finds out.
 *
 *   GET /api/schemes/export?scheme=<uuid>&format=xlsx|pdf&from=&to=
 *   GET /api/schemes/export?scheme=<uuid>&format=xlsx|pdf&period=2026-08-01
 *
 * `period` is shorthand for the whole month and is what the monthly statement
 * uses; `from`/`to` serves the weekly and ad-hoc downloads. Everything is
 * fetched through list_scheme_charges, which re-checks the caller's site — so
 * the range in the query string cannot widen what a user may see, only narrow
 * it.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { requireStaffSession, requireRole } from '@/lib/api-auth';
import { formatKes } from '@/lib/billing';
import {
  EXPORT_HEADERS, exportRows, totalCharges, memberRole,
  periodEnd, periodLabel, dayLabel, centsToShillings,
  type SchemeCharge,
} from '@/lib/schemes';
import { buildXlsx, XLSX_CONTENT_TYPE } from '@/lib/xlsx';
import { buildPdf, PDF_CONTENT_TYPE, type PdfColumn } from '@/lib/pdf';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Nairobi's calendar day, not the host's. A server in UTC would file a 01:30
 *  local download under the previous day. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** A filename component that cannot escape the Content-Disposition header.
 *  A scheme name is administrator-entered, so it is not trusted here. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';
}

export async function GET(req: NextRequest) {
  const auth = await requireStaffSession(req);
  if ('error' in auth) return auth.error;
  // The desk roles plus the two that review. A clinician does not download a
  // customer's invoice.
  const denied = requireRole(auth.session, 'ADMIN', 'RECEPTIONIST', 'AUDITOR');
  if (denied) return denied;

  const q = req.nextUrl.searchParams;
  const schemeId = q.get('scheme') ?? '';
  const format = (q.get('format') ?? 'xlsx').toLowerCase();
  const period = q.get('period');

  if (!schemeId) return NextResponse.json({ error: 'scheme is required' }, { status: 400 });
  if (format !== 'xlsx' && format !== 'pdf') {
    return NextResponse.json({ error: 'format must be xlsx or pdf' }, { status: 400 });
  }

  let from = q.get('from') ?? '';
  let to = q.get('to') ?? '';
  if (period) {
    if (!DATE.test(period)) return NextResponse.json({ error: 'period must be YYYY-MM-DD' }, { status: 400 });
    from = `${period.slice(0, 7)}-01`;
    to = periodEnd(from);
  }
  if (!DATE.test(from) || !DATE.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD' }, { status: 400 });
  }
  if (to < from) {
    return NextResponse.json({ error: 'the end of the range is before its start' }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createServerClient(url, anon, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });

  // The scheme's own row is read through PostgREST rather than list_schemes,
  // which takes a site id this handler does not have — and asking the client
  // for one would let the query string choose whose data to name on the
  // document. schemes has SELECT granted with an RLS policy scoped to the
  // caller's site, so an id belonging to another site simply returns nothing.
  const [{ data: chargeData, error }, { data: schemeRow, error: schemeError }, { data: capData }] =
    await Promise.all([
      supabase.rpc('list_scheme_charges', {
        p_scheme_id: schemeId, p_from: from, p_to: to, p_include_void: false,
      }),
      supabase.from('schemes').select('code,name').eq('id', schemeId).maybeSingle(),
      supabase.rpc('scheme_cap_cents', { p_scheme_id: schemeId, p_period: from }),
    ]);

  if (error) {
    // list_scheme_charges' own refusals are the authorization boundary — an
    // unknown scheme, or one belonging to another site, lands here. Its message
    // is written for a human and is safe to pass on.
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (schemeError || !schemeRow) {
    // Refused rather than falling back to a placeholder name. A statement
    // headed "Scheme" is worse than no statement: it looks issuable, and
    // somebody would send it.
    return NextResponse.json(
      { error: 'That scheme could not be found for your site.' },
      { status: 404 },
    );
  }

  const charges = (chargeData ?? []) as SchemeCharge[];
  const schemeName = schemeRow.name as string;
  const schemeCode = schemeRow.code as string;
  const capCents = typeof capData === 'number' ? capData : null;

  const totals = totalCharges(charges);
  const rangeLabel = period
    ? periodLabel(from)
    : `${dayLabel(from)} to ${dayLabel(to)}`;
  const stamp = period ? from.slice(0, 7) : `${from}_${to}`;
  const base = `${slug(schemeCode)}-${stamp}`;

  if (format === 'xlsx') {
    // Row 1 is the farms' own header. Everything below it is their layout,
    // day-blocked with a blank line between days, so the sheet drops straight
    // into the workbook they already reconcile against.
    const rows = [
      [...EXPORT_HEADERS],
      ...exportRows(charges),
      [],
      ['TOTAL', `${totals.visits} visits`, null,
        centsToShillings(totals.consultation_cents), null,
        centsToShillings(totals.lab_cents), null,
        centsToShillings(totals.surgical_cents), null,
        centsToShillings(totals.pharmacy_cents)],
      ['GRAND TOTAL', null, null, null, null, null, null, null, null,
        centsToShillings(totals.total_cents)],
    ];
    if (totals.over_limit_cents > 0) {
      rows.push([`OF WHICH OVER LIMIT`, null, null, null, null, null, null, null, null,
        centsToShillings(totals.over_limit_cents)]);
    }

    const buf = buildXlsx([{
      name: period ? periodLabel(from) : 'Charges',
      headerRow: true,
      widths: [12, 30, 10, 8, 22, 10, 20, 10, 42, 10],
      rows,
    }]);

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': XLSX_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="${base}.xlsx"`,
        // Real time means real time: a cached statement is a wrong statement
        // the moment another visit is posted.
        'Cache-Control': 'no-store',
      },
    });
  }

  // Landscape, and every one of the farms' columns present. Portrait A4 would
  // force either a dropped column or drug lists cut to a few characters, and
  // both hide part of what the farm is being asked to pay for.
  const columns: PdfColumn[] = [
    { header: 'DATE', width: 56 },
    { header: 'NAME', width: 130, flex: true },
    { header: 'PAYROLL', width: 46 },
    { header: 'RELATION', width: 48 },
    { header: 'CONS', width: 40, align: 'right' },
    { header: 'LAB', width: 90, flex: true },
    { header: 'LAB KSh', width: 42, align: 'right' },
    { header: 'SURGICAL', width: 90, flex: true },
    { header: 'SURG KSh', width: 42, align: 'right' },
    { header: 'PHARMACY', width: 170, flex: true },
    { header: 'PHARM KSh', width: 46, align: 'right' },
    { header: 'TOTAL', width: 50, align: 'right' },
  ];

  const money = (c: number) => (c ? formatKes(c, { symbol: false }) : '');

  const buf = buildPdf({
    landscape: true,
    title: schemeName,
    subtitle: `${period ? 'Monthly statement' : 'Utilisation report'} · ${rangeLabel} · Vitcare Health Center, Naivasha`,
    meta: [
      { label: 'Visits', value: String(totals.visits) },
      { label: 'Total', value: formatKes(totals.total_cents) },
      ...(capCents != null
        ? [{ label: 'Monthly limit', value: formatKes(capCents) }] : []),
      ...(totals.over_limit_cents > 0
        // Called out on the face of the document rather than buried in a
        // column: this is the portion the farm has to approve.
        ? [{ label: 'Of which over limit', value: formatKes(totals.over_limit_cents) }] : []),
      { label: 'Generated', value: `${dayLabel(today())} (Africa/Nairobi)` },
    ],
    columns,
    rows: charges.map((c) => [
      c.service_date,
      c.full_name,
      c.employee_no,
      memberRole(c),
      money(c.consultation_cents),
      c.lab_description ?? '',
      money(c.lab_cents),
      c.surgical_description ?? '',
      money(c.surgical_cents),
      c.pharmacy_description ?? '',
      money(c.pharmacy_cents),
      // Marked on the line as well as summarised at the top, so the farm can
      // see exactly which visits it is being asked to approve.
      money(c.total_cents) + (c.over_limit ? ' *' : ''),
    ]),
    totals: [
      '', `${totals.visits} visits`, '', '',
      money(totals.consultation_cents), '', money(totals.lab_cents), '',
      money(totals.surgical_cents), '', money(totals.pharmacy_cents),
      money(totals.total_cents),
    ],
    footer: totals.over_limit_cents > 0
      ? 'Vitcare Health Center, Naivasha · figures in Kenya Shillings · * this visit took the month past the agreed limit'
      : 'Vitcare Health Center, Naivasha · figures in Kenya Shillings',
  });

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': PDF_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${base}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
