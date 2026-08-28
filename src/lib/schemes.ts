/**
 * Corporate schemes — the flower farms' side of the ledger.
 *
 * Same division of labour as billing.ts: the DATABASE owns every figure. It
 * derives a charge's total by trigger, decides whether a charge crossed the
 * cap at the moment it was posted, and totals a statement from the charges it
 * covers. Nothing here recomputes any of that.
 *
 * What this file does is:
 *   · describe the shapes the RPCs return, so a renamed column is a type error
 *     rather than an `undefined` on a financial screen;
 *   · derive the small presentational facts — how close to the cap, which tone
 *     to paint it, what a period is called;
 *   · shape the export rows, because the farms' workbooks have a specific
 *     column order and a specific day-block layout that their finance offices
 *     reconcile against.
 */

import { formatKes } from './billing';

export type Relation = 'SELF' | 'SPOUSE' | 'CHILD';
export type EmploymentType = 'PERMANENT' | 'CONTRACT' | 'SEASONAL';
export type ChargeStatus = 'OPEN' | 'STATEMENTED' | 'VOID';
export type StatementStatus = 'DRAFT' | 'ISSUED' | 'VOID';

export interface Scheme {
  id: string;
  code: string;
  name: string;
  consultation_fee_cents: number;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  active: boolean;
  members: number;
  /** Null when finance has not agreed a ceiling. Not zero — see below. */
  cap_cents: number | null;
}

export interface SchemeMember {
  member_id: string;
  patient_id: string;
  employee_no: string;
  member_no: string | null;
  relation: Relation;
  child_ref: string | null;
  full_name: string;
  mrn: string;
  dob: string | null;
  sex: string | null;
  phone: string | null;
  national_id: string | null;
  employment_type: EmploymentType | null;
  employed_on: string | null;
  covered_from: string;
  covered_to: string | null;
  covered: boolean;
  visits_this_month: number;
  spend_this_month_cents: number;
}

/**
 * What lookup_scheme_member returns — a different shape from the register.
 *
 * The desk searching before it treats someone needs the HOUSEHOLD's position,
 * because the payroll number is the account; the register screen needs each
 * individual's own activity. Two RPCs, two types, so a column that exists in
 * one and not the other is a compile error rather than an `undefined` rendered
 * into a money field.
 */
export interface SchemeMemberLookup {
  member_id: string;
  patient_id: string;
  employee_no: string;
  member_no: string | null;
  relation: Relation;
  child_ref: string | null;
  full_name: string;
  mrn: string;
  dob: string | null;
  sex: string | null;
  employment_type: EmploymentType | null;
  covered_from: string;
  covered_to: string | null;
  covered: boolean;
  /** The employee this person draws on — null on the employee's own row. */
  employee_name: string | null;
  household_size: number;
  month_spend_cents: number;
}

export interface SchemeCharge {
  charge_id: string;
  service_date: string;
  full_name: string;
  employee_no: string;
  member_no: string | null;
  relation: Relation;
  /** The employer's A-D letter for a child, so a statement line can be matched
   *  against the farm's own register by eye. */
  child_ref: string | null;
  mrn: string;
  consultation_cents: number;
  lab_description: string | null;
  lab_cents: number;
  surgical_description: string | null;
  surgical_cents: number;
  pharmacy_description: string | null;
  pharmacy_cents: number;
  total_cents: number;
  over_limit: boolean;
  status: ChargeStatus;
  void_reason: string | null;
  posted_by: string | null;
  posted_at: string;
}

export interface SchemeUtilisation {
  scheme_id: string;
  code: string;
  name: string;
  period: string;
  visits: number;
  members: number;
  consultation_cents: number;
  lab_cents: number;
  surgical_cents: number;
  pharmacy_cents: number;
  spent_cents: number;
  cap_cents: number | null;
  remaining_cents: number | null;
  used_pct: number | null;
  over_limit_cents: number;
  over_limit_visits: number;
  statement_status: StatementStatus | null;
  statement_no: string | null;
}

export interface SchemeStatement {
  id: string;
  scheme_id: string;
  code: string;
  name: string;
  period: string;
  statement_no: string | null;
  status: StatementStatus;
  visits: number;
  consultation_cents: number;
  lab_cents: number;
  surgical_cents: number;
  pharmacy_cents: number;
  total_cents: number;
  over_limit_cents: number;
  cap_cents: number | null;
  issued_at: string | null;
  issued_by_name: string | null;
  void_reason: string | null;
}

export const RELATION_LABEL: Record<Relation, string> = {
  SELF: 'Employee',
  SPOUSE: 'Spouse',
  CHILD: 'Child',
};

export const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  PERMANENT: 'Permanent',
  CONTRACT: 'Contract',
  SEASONAL: 'Seasonal',
};

export const STATEMENT_STATUS_LABEL: Record<StatementStatus, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  VOID: 'Void',
};

/**
 * How a member is described on a list: "Employee", "Spouse", "Child B".
 * The farms label children A–D on their own registers, and reusing their
 * letter is what lets a clinic row be matched to an employer row by eye.
 */
export function memberRole(m: Pick<SchemeMember, 'relation' | 'child_ref'>): string {
  if (m.relation === 'CHILD' && m.child_ref) return `Child ${m.child_ref}`;
  return RELATION_LABEL[m.relation];
}

/**
 * Where a farm's month stands.
 *
 * A NULL cap means no ceiling has been agreed, which is a real state and not
 * the same as a ceiling of zero. Treating it as zero would paint every farm
 * permanently over limit; treating it as unlimited-but-unknown is honest, and
 * the screen says so in words.
 */
export type LimitTone = 'none' | 'ok' | 'warn' | 'over';

export function limitTone(u: Pick<SchemeUtilisation, 'cap_cents' | 'spent_cents'>): LimitTone {
  if (u.cap_cents === null || u.cap_cents <= 0) return 'none';
  if (u.spent_cents > u.cap_cents) return 'over';
  // 80% is where the desk still has room to act. Past it the farm needs telling
  // before the month ends, not after.
  if (u.spent_cents >= u.cap_cents * 0.8) return 'warn';
  return 'ok';
}

export const LIMIT_TONE_LABEL: Record<LimitTone, string> = {
  none: 'No limit set',
  ok: 'Within limit',
  warn: 'Approaching limit',
  over: 'Over limit',
};

/** 0–100 for the bar. Capped so a 140%-spent farm does not render off-screen;
 *  the number beside it still reads 140%, so nothing is hidden. */
export function usedPercent(u: Pick<SchemeUtilisation, 'cap_cents' | 'spent_cents'>): number | null {
  if (u.cap_cents === null || u.cap_cents <= 0) return null;
  return Math.min(100, Math.round((u.spent_cents / u.cap_cents) * 1000) / 10);
}

/** The true figure, uncapped, for the text beside the bar. */
export function usedPercentExact(u: Pick<SchemeUtilisation, 'cap_cents' | 'spent_cents'>): number | null {
  if (u.cap_cents === null || u.cap_cents <= 0) return null;
  return Math.round((u.spent_cents / u.cap_cents) * 1000) / 10;
}

/**
 * A period ("2026-08-01") as "August 2026".
 *
 * Parsed by hand rather than through `new Date(period)`. A bare YYYY-MM-DD is
 * parsed as UTC midnight, and in any timezone behind UTC that renders as the
 * previous month — which would label the August statement "July" for a clinic
 * that is in fact ahead of UTC but would break the moment this ran anywhere
 * else. The month is data, not a moment in time.
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  if (!m) return period;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return period;
  return `${MONTHS[month - 1]} ${m[1]}`;
}

/** "2026-08-14" → "14 Aug 2026", same reasoning as above. */
export function dayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return date;
  return `${Number(m[3])} ${MONTHS[month - 1].slice(0, 3)} ${m[1]}`;
}

/** First day of the month a date falls in, as YYYY-MM-DD. String arithmetic
 *  for the reason above: no Date object touches a period. */
export function periodOf(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  return m ? `${m[1]}-${m[2]}-01` : date;
}

/** The N most recent periods, newest first, ending at `from`'s month. */
export function recentPeriods(from: string, count: number): string[] {
  const m = /^(\d{4})-(\d{2})/.exec(from);
  if (!m) return [];
  let year = Number(m[1]);
  let month = Number(m[2]);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${year}-${String(month).padStart(2, '0')}-01`);
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return out;
}

/** Last day of a period's month. Day 0 of the NEXT month is the last day of
 *  this one, which is also how February and leap years come out right without
 *  a table. Built in UTC and read back in UTC so no timezone can shift it. */
export function periodEnd(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  if (!m) return period;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0));
  return d.toISOString().slice(0, 10);
}

/** The Monday-to-Sunday week a date falls in, as [from, to]. Kenyan clinics
 *  and both farms' sheets run Monday-first. */
export function weekOf(date: string): [string, string] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return [date, date];
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // getUTCDay: 0 = Sunday. Shift so Monday is 0.
  const shift = (d.getUTCDay() + 6) % 7;
  const start = new Date(d.getTime() - shift * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

/**
 * Totals for a set of charges, in the farms' four columns.
 *
 * This is a SUM OF SERVER FIGURES, not a recomputation of any of them: each
 * charge's total_cents was derived by the database. Adding up rows the server
 * already priced is arithmetic; re-deriving a row's price here would be a
 * second opinion, and a second opinion on an invoice is a defect.
 */
export interface ChargeTotals {
  visits: number;
  consultation_cents: number;
  lab_cents: number;
  surgical_cents: number;
  pharmacy_cents: number;
  total_cents: number;
  over_limit_cents: number;
}

export function totalCharges(rows: readonly SchemeCharge[]): ChargeTotals {
  const live = rows.filter((r) => r.status !== 'VOID');
  return {
    visits: live.length,
    consultation_cents: live.reduce((a, r) => a + r.consultation_cents, 0),
    lab_cents: live.reduce((a, r) => a + r.lab_cents, 0),
    surgical_cents: live.reduce((a, r) => a + r.surgical_cents, 0),
    pharmacy_cents: live.reduce((a, r) => a + r.pharmacy_cents, 0),
    total_cents: live.reduce((a, r) => a + r.total_cents, 0),
    over_limit_cents: live.filter((r) => r.over_limit).reduce((a, r) => a + r.total_cents, 0),
  };
}

/** Group charges into the day blocks the farms' sheets are written in. */
export function groupByDay(rows: readonly SchemeCharge[]): Array<{ date: string; rows: SchemeCharge[] }> {
  const map = new Map<string, SchemeCharge[]>();
  for (const r of rows) {
    const list = map.get(r.service_date);
    if (list) list.push(r); else map.set(r.service_date, [r]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, list]) => ({ date, rows: list }));
}

/**
 * The workbook layout, exactly as the farms keep it.
 *
 * DATE appears only on the first row of each day and the days are separated by
 * a blank row — that is not decoration, it is how their finance offices read
 * the sheet, and an export that flattens it is an export they have to re-format
 * before they can use it. The description column sits immediately left of its
 * money column for each of LAB, SURGICAL and PHARMACY, which is the pairing
 * their existing sheets use.
 */
export const EXPORT_HEADERS = [
  'DATE', 'NAME', 'PAYROLL', 'CONS', 'LAB', 'LAB', 'SURGICAL', 'SURG', 'PHARMACY', 'PHARM',
] as const;

export type ExportCell = string | number | null;

export function exportRows(charges: readonly SchemeCharge[]): ExportCell[][] {
  const out: ExportCell[][] = [];
  const days = groupByDay(charges.filter((c) => c.status !== 'VOID'));
  days.forEach(({ date, rows }, dayIndex) => {
    if (dayIndex > 0) out.push([]);            // the blank separator row
    rows.forEach((r, i) => {
      out.push([
        i === 0 ? date : null,                 // DATE on the first row only
        r.full_name,
        r.employee_no,
        r.consultation_cents / 100,
        r.lab_description,
        r.lab_cents ? r.lab_cents / 100 : null,
        r.surgical_description,
        r.surgical_cents ? r.surgical_cents / 100 : null,
        r.pharmacy_description,
        r.pharmacy_cents ? r.pharmacy_cents / 100 : null,
      ]);
    });
  });
  return out;
}

/** Money for the export: shillings, not cents, because that is what the farms'
 *  sheets hold and a workbook cell should be a number they can sum. Division
 *  by 100 is exact here — every amount is a whole number of cents and the
 *  quotient is at most two decimal places, well inside a float's precision. */
export const centsToShillings = (cents: number) => cents / 100;

/** Mirrors issue_scheme_statement: a month can only be invoiced once it is
 *  over, and only a draft with visits on it can be issued. */
export function canIssueStatement(
  s: Pick<SchemeStatement, 'status' | 'visits' | 'period'>,
  today: string,
): boolean {
  return s.status === 'DRAFT' && s.visits > 0 && s.period < periodOf(today);
}

/** A one-line summary for the tracker card. */
export function limitSummary(u: SchemeUtilisation): string {
  if (u.cap_cents === null || u.cap_cents <= 0) {
    return `${formatKes(u.spent_cents)} this month · no limit set`;
  }
  const pct = usedPercentExact(u);
  const remaining = u.cap_cents - u.spent_cents;
  if (remaining < 0) {
    return `${formatKes(u.spent_cents)} of ${formatKes(u.cap_cents)} · ${formatKes(-remaining)} over (${pct}%)`;
  }
  return `${formatKes(u.spent_cents)} of ${formatKes(u.cap_cents)} · ${formatKes(remaining)} left (${pct}%)`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Treating a corporate patient
 *
 * Everything below serves the clinical side of a scheme: the price list the
 * facility agreed with each farm, the cover banner the clinician sees, and
 * the sentence shown after a visit is posted. Same rule as above — the
 * database owns every figure; these turn figures into words.
 * ──────────────────────────────────────────────────────────────────────── */

/** Which of the farm's four columns a service bills under. */
export type TariffBucket = 'CONSULTATION' | 'LAB' | 'SURGICAL' | 'PHARMACY';

export const BUCKET_LABEL: Record<TariffBucket, string> = {
  CONSULTATION: 'Consultation',
  LAB: 'Lab',
  SURGICAL: 'Surgical',
  PHARMACY: 'Pharmacy',
};

export const BUCKETS: readonly TariffBucket[] = [
  'CONSULTATION',
  'LAB',
  'SURGICAL',
  'PHARMACY',
];

/**
 * A row of list_scheme_tariffs: one catalogue service, with the farm's price
 * beside it when the contract covers it.
 *
 * `price_cents === null` means NOT COVERED, and it is deliberately a different
 * state from a price of zero. Zero is "the contract includes this at no
 * charge"; null is "nobody has agreed what this costs", which is what
 * post_scheme_charge_from_encounter refuses on. Rendering the two the same way
 * would hide the only thing this screen exists to show.
 */
export interface SchemeTariff {
  service_id: string;
  code: string;
  name: string;
  category: string;
  module: string;
  unit: string | null;
  cash_price_cents: number;
  insurance_price_cents: number;
  tariff_id: string | null;
  price_cents: number | null;
  bucket: TariffBucket | null;
  effective_from: string | null;
  note: string | null;
  set_by_name: string | null;
}

/** What encounter_scheme_context returns. No rows at all for a cash visit. */
export interface EncounterSchemeContext {
  member_id: string;
  scheme_id: string;
  scheme_code: string;
  scheme_name: string;
  employee_no: string;
  relation: Relation;
  child_ref: string | null;
  member_name: string;
  employee_name: string | null;
  household_size: number;
  covered_from: string;
  covered_to: string | null;
  covered: boolean;
  cap_cents: number | null;
  spent_cents: number;
  remaining_cents: number | null;
  household_month_cents: number;
  charge_id: string | null;
  charge_total_cents: number | null;
  charge_status: ChargeStatus | null;
}

/** What post_scheme_charge_from_encounter returns. */
export interface PostedSchemeCharge {
  charge_id: string;
  total_cents: number;
  over_limit: boolean;
  cap_cents: number | null;
  spent_cents: number;
  remaining_cents: number | null;
  priced_count: number;
  skipped_count: number;
}

/**
 * The banner line a clinician reads before deciding anything.
 *
 * Names the company first because that is the fact that changes the decision,
 * then who this person is on the farm's register. The household's month is
 * included when there is one — SRK 646 made eleven visits in August and the
 * desk asked to be able to see that.
 */
export function coverSummary(ctx: EncounterSchemeContext): string {
  const who =
    ctx.relation === 'SELF'
      ? `payroll ${ctx.employee_no}`
      : `${memberRole(ctx)} of ${ctx.employee_name ?? `payroll ${ctx.employee_no}`}`;
  const parts = [ctx.scheme_name, who];
  if (!ctx.covered) parts.push('NOT COVERED TODAY');
  if (ctx.household_month_cents > 0) {
    parts.push(`${formatKes(ctx.household_month_cents)} on this account this month`);
  }
  return parts.join(' · ');
}

/**
 * Where the FARM's month stands, for the banner.
 *
 * Reuses limitTone so the consult screen and the tracker cannot disagree about
 * what "approaching" means. The cap never blocks care — 0030 recorded that as
 * a decision of the facility — so this is worded as information, not a barrier.
 */
export function schemeMonthSummary(ctx: EncounterSchemeContext): string {
  if (ctx.cap_cents === null || ctx.cap_cents <= 0) {
    return `${formatKes(ctx.spent_cents)} this month · no limit set`;
  }
  const remaining = ctx.cap_cents - ctx.spent_cents;
  if (remaining < 0) {
    return `${formatKes(ctx.spent_cents)} of ${formatKes(ctx.cap_cents)} · ${formatKes(-remaining)} over`;
  }
  return `${formatKes(ctx.spent_cents)} of ${formatKes(ctx.cap_cents)} · ${formatKes(remaining)} left`;
}

/** The services this contract does not price — what a posting will refuse on. */
export function untariffed(rows: readonly SchemeTariff[]): SchemeTariff[] {
  return rows.filter((r) => r.price_cents === null);
}

export interface TariffCoverage {
  covered: number;
  total: number;
  /** Null rather than 0 for an empty catalogue: "0% priced" would be a lie
   *  about a list that has nothing in it to price. */
  percent: number | null;
}

export function tariffCoverage(rows: readonly SchemeTariff[]): TariffCoverage {
  const total = rows.length;
  const covered = rows.filter((r) => r.price_cents !== null).length;
  return {
    covered,
    total,
    percent: total === 0 ? null : Math.round((covered / total) * 1000) / 10,
  };
}

/** Catalogue order, grouped for the price-list screen. */
export function groupTariffsByCategory(
  rows: readonly SchemeTariff[],
): Array<{ category: string; rows: SchemeTariff[] }> {
  const out: Array<{ category: string; rows: SchemeTariff[] }> = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.category === row.category) last.rows.push(row);
    else out.push({ category: row.category, rows: [row] });
  }
  return out;
}

/**
 * How far a farm's price differs from the walk-in rate, as a signed percent.
 *
 * Shown beside each priced row so an administrator can see at a glance that
 * Stokman's consultation is 80% below the catalogue — which is the fact that
 * makes a per-scheme price list necessary rather than a nicety.
 */
export function tariffDelta(row: SchemeTariff): number | null {
  if (row.price_cents === null || row.cash_price_cents <= 0) return null;
  return Math.round(((row.price_cents - row.cash_price_cents) / row.cash_price_cents) * 1000) / 10;
}

/**
 * The sentence shown after a clinician posts a visit.
 *
 * Says what went on the bill AND what deliberately did not. A silent skip is
 * how the facility ended up with 163 unpriced pharmacy lines in one month;
 * naming the count every time makes "why is this not on the invoice" a
 * question that answers itself.
 */
export function postSummary(r: PostedSchemeCharge): string {
  const parts = [`${formatKes(r.total_cents)} posted to the scheme`];
  if (r.priced_count > 0) {
    parts.push(`${r.priced_count} service${r.priced_count === 1 ? '' : 's'} priced`);
  }
  if (r.skipped_count > 0) {
    parts.push(
      `${r.skipped_count} not chargeable to the scheme (statutory, or priced at the pharmacy till)`,
    );
  }
  if (r.over_limit) {
    parts.push('this visit takes the company past its monthly limit');
  }
  return parts.join(' · ');
}
