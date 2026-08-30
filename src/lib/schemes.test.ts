/**
 * The scheme module's presentational rules.
 *
 * Same purpose as catalogue.test.ts: everything here is a transcription of a
 * decision the DATABASE makes, so a failure means the mirror has drifted from
 * the server. The figures come from the farms' own August 2026 sheets and from
 * the rolled-back transaction the RPCs were proved in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  memberRole, limitTone, usedPercent, usedPercentExact, periodLabel, dayLabel,
  periodOf, periodEnd, recentPeriods, weekOf, totalCharges, groupByDay,
  exportRows, EXPORT_HEADERS, canIssueStatement, limitSummary,
  coverSummary, schemeMonthSummary, untariffed, tariffCoverage, tariffDelta,
  groupTariffsByCategory, postSummary,
  type SchemeCharge, type SchemeUtilisation, type SchemeTariff,
  type EncounterSchemeContext, type PostedSchemeCharge,
} from './schemes';

const charge = (over: Partial<SchemeCharge> = {}): SchemeCharge => ({
  charge_id: 'c1', service_date: '2026-08-14', full_name: 'ZAKIUS OWINO ABIERO',
  employee_no: '646', member_no: null, relation: 'SELF', child_ref: null, mrn: 'VC-1',
  consultation_cents: 10_000,
  lab_description: null, lab_cents: 0,
  surgical_description: null, surgical_cents: 0,
  pharmacy_description: null, pharmacy_cents: 0,
  total_cents: 10_000, over_limit: false, status: 'OPEN', void_reason: null,
  posted_by: 'Desk', posted_at: '2026-08-14T09:00:00Z',
  ...over,
});

const util = (over: Partial<SchemeUtilisation> = {}): SchemeUtilisation => ({
  scheme_id: 's1', code: 'SRK', name: 'Stokman Rozen Kenya Ltd', period: '2026-08-01',
  visits: 0, members: 0,
  consultation_cents: 0, lab_cents: 0, surgical_cents: 0, pharmacy_cents: 0,
  spent_cents: 0, cap_cents: null, remaining_cents: null, used_pct: null,
  over_limit_cents: 0, over_limit_visits: 0,
  statement_status: null, statement_no: null,
  ...over,
});

describe('memberRole', () => {
  test('names the employee and the spouse plainly', () => {
    assert.equal(memberRole({ relation: 'SELF', child_ref: null }), 'Employee');
    assert.equal(memberRole({ relation: 'SPOUSE', child_ref: null }), 'Spouse');
  });

  test("keeps the employer's A-D letter on a child, so the two registers match by eye", () => {
    assert.equal(memberRole({ relation: 'CHILD', child_ref: 'B' }), 'Child B');
  });

  test('falls back to "Child" when no letter was recorded', () => {
    assert.equal(memberRole({ relation: 'CHILD', child_ref: null }), 'Child');
  });
});

describe('limitTone', () => {
  test('distinguishes "no cap agreed" from "a cap of zero"', () => {
    // The whole point: an unset limit must not paint every farm over limit and
    // train the desk to ignore the warning.
    assert.equal(limitTone({ cap_cents: null, spent_cents: 500_000 }), 'none');
    assert.equal(limitTone({ cap_cents: 0, spent_cents: 500_000 }), 'none');
  });

  test('warns from 80% so the farm can be told before the month ends', () => {
    assert.equal(limitTone({ cap_cents: 100_000, spent_cents: 79_999 }), 'ok');
    assert.equal(limitTone({ cap_cents: 100_000, spent_cents: 80_000 }), 'warn');
    assert.equal(limitTone({ cap_cents: 100_000, spent_cents: 100_000 }), 'warn');
  });

  test('is only "over" once the cap is exceeded, not when it is exactly met', () => {
    assert.equal(limitTone({ cap_cents: 100_000, spent_cents: 100_001 }), 'over');
  });
});

describe('usedPercent', () => {
  test('caps the bar at 100 but reports the true figure beside it', () => {
    // Proved live: SRK spent 280,000 against a 200,000 cap and the tracker
    // read 140.0%.
    const u = { cap_cents: 200_000, spent_cents: 280_000 };
    assert.equal(usedPercent(u), 100);
    assert.equal(usedPercentExact(u), 140);
  });

  test('returns null rather than a misleading zero when no cap is set', () => {
    assert.equal(usedPercent({ cap_cents: null, spent_cents: 5_000 }), null);
    assert.equal(usedPercentExact({ cap_cents: null, spent_cents: 5_000 }), null);
  });

  test('keeps one decimal place', () => {
    assert.equal(usedPercentExact({ cap_cents: 300_000, spent_cents: 100_000 }), 33.3);
  });
});

describe('period and day labels', () => {
  test('names a month without going through Date', () => {
    // new Date('2026-08-01') is UTC midnight; rendered west of UTC it is July,
    // which would label the August statement "July 2026".
    assert.equal(periodLabel('2026-08-01'), 'August 2026');
    assert.equal(periodLabel('2026-01-01'), 'January 2026');
    assert.equal(periodLabel('2026-12-01'), 'December 2026');
  });

  test('leaves anything that is not a period alone', () => {
    assert.equal(periodLabel('not-a-date'), 'not-a-date');
    assert.equal(periodLabel('2026-13-01'), '2026-13-01');
  });

  test('renders a day the way the clinic writes one', () => {
    assert.equal(dayLabel('2026-08-14'), '14 Aug 2026');
    assert.equal(dayLabel('2026-08-01'), '1 Aug 2026');
  });
});

describe('periodOf / periodEnd', () => {
  test('finds the month a visit belongs to', () => {
    assert.equal(periodOf('2026-08-31'), '2026-08-01');
  });

  test('finds the last day of a month, including February in a leap year', () => {
    assert.equal(periodEnd('2026-08-01'), '2026-08-31');
    assert.equal(periodEnd('2026-02-01'), '2026-02-28');
    assert.equal(periodEnd('2028-02-01'), '2028-02-29');
    assert.equal(periodEnd('2026-12-01'), '2026-12-31');
  });
});

describe('recentPeriods', () => {
  test('walks back across a year boundary', () => {
    assert.deepEqual(recentPeriods('2026-02-14', 4), [
      '2026-02-01', '2026-01-01', '2025-12-01', '2025-11-01',
    ]);
  });
});

describe('weekOf', () => {
  test('runs Monday to Sunday', () => {
    // 2026-08-14 is a Friday.
    assert.deepEqual(weekOf('2026-08-14'), ['2026-08-10', '2026-08-16']);
  });

  test('treats Sunday as the END of its week, not the start of the next', () => {
    assert.deepEqual(weekOf('2026-08-16'), ['2026-08-10', '2026-08-16']);
  });

  test('handles a Monday', () => {
    assert.deepEqual(weekOf('2026-08-10'), ['2026-08-10', '2026-08-16']);
  });
});

describe('totalCharges', () => {
  test('adds up the four columns the farms keep', () => {
    const rows = [
      charge({
        lab_description: 'BS/UA', lab_cents: 30_000,
        pharmacy_description: 'diclo inj/tabs/gel', pharmacy_cents: 75_000,
        total_cents: 115_000,
      }),
      charge({
        charge_id: 'c2',
        pharmacy_description: 'piriton/brufen/alcof', pharmacy_cents: 45_000,
        total_cents: 55_000,
      }),
    ];
    const t = totalCharges(rows);
    assert.equal(t.visits, 2);
    assert.equal(t.consultation_cents, 20_000);
    assert.equal(t.lab_cents, 30_000);
    assert.equal(t.pharmacy_cents, 120_000);
    assert.equal(t.total_cents, 170_000);
  });

  test('excludes voided visits — a voided visit is not spend', () => {
    const rows = [
      charge({ total_cents: 115_000 }),
      charge({ charge_id: 'c2', status: 'VOID', void_reason: 'entered twice', total_cents: 55_000 }),
    ];
    const t = totalCharges(rows);
    assert.equal(t.visits, 1);
    assert.equal(t.total_cents, 115_000);
  });

  test('totals the over-limit portion separately, for the farm to approve', () => {
    const rows = [
      charge({ total_cents: 115_000 }),
      charge({ charge_id: 'c2', over_limit: true, total_cents: 55_000 }),
    ];
    assert.equal(totalCharges(rows).over_limit_cents, 55_000);
  });
});

describe('groupByDay', () => {
  test('blocks the register by day, in date order', () => {
    const rows = [
      charge({ charge_id: 'a', service_date: '2026-08-14' }),
      charge({ charge_id: 'b', service_date: '2026-08-12' }),
      charge({ charge_id: 'c', service_date: '2026-08-14' }),
    ];
    const days = groupByDay(rows);
    assert.deepEqual(days.map((d) => d.date), ['2026-08-12', '2026-08-14']);
    assert.equal(days[1].rows.length, 2);
  });
});

describe('exportRows', () => {
  const rows = [
    charge({
      charge_id: 'a', service_date: '2026-08-12', full_name: 'A ONE',
      pharmacy_description: 'diclo', pharmacy_cents: 75_000, total_cents: 85_000,
    }),
    charge({ charge_id: 'b', service_date: '2026-08-12', full_name: 'B TWO' }),
    charge({
      charge_id: 'c', service_date: '2026-08-14', full_name: 'C THREE',
      lab_description: 'BS', lab_cents: 30_000, total_cents: 40_000,
    }),
  ];

  test('uses the farms’ own column order', () => {
    assert.deepEqual([...EXPORT_HEADERS], [
      'DATE', 'NAME', 'PAYROLL', 'CONS', 'LAB', 'LAB', 'SURGICAL', 'SURG', 'PHARMACY', 'PHARM',
    ]);
  });

  test('writes DATE on the first row of each day only, as their sheets do', () => {
    const out = exportRows(rows);
    assert.equal(out[0][0], '2026-08-12');
    assert.equal(out[1][0], null);
  });

  test('separates day blocks with a blank row', () => {
    const out = exportRows(rows);
    // two rows for 12 Aug, a blank separator, one row for 14 Aug
    assert.equal(out.length, 4);
    assert.deepEqual(out[2], []);
    assert.equal(out[3][1], 'C THREE');
  });

  test('exports money in shillings, because that is what the sheets hold', () => {
    const out = exportRows(rows);
    assert.equal(out[0][3], 100);   // CONS, 10_000 cents
    assert.equal(out[0][9], 750);   // PHARM, 75_000 cents
  });

  test('leaves an untouched column empty rather than writing a zero', () => {
    // A zero in the LAB column reads as "lab was done and cost nothing".
    // Blank is the truthful cell, and it is what their sheets contain.
    const out = exportRows(rows);
    assert.equal(out[0][5], null);
    assert.equal(out[0][7], null);
  });

  test('omits voided visits entirely', () => {
    const out = exportRows([
      ...rows,
      charge({ charge_id: 'd', service_date: '2026-08-14', status: 'VOID', void_reason: 'x' }),
    ]);
    assert.equal(out.filter((r) => r.length > 0).length, 3);
  });
});

describe('canIssueStatement', () => {
  test('refuses a month that is not over yet', () => {
    assert.equal(
      canIssueStatement({ status: 'DRAFT', visits: 5, period: '2026-08-01' }, '2026-08-25'),
      false,
    );
  });

  test('allows it from the 1st of the following month', () => {
    assert.equal(
      canIssueStatement({ status: 'DRAFT', visits: 5, period: '2026-08-01' }, '2026-09-01'),
      true,
    );
  });

  test('refuses an empty month and an already-issued statement', () => {
    assert.equal(
      canIssueStatement({ status: 'DRAFT', visits: 0, period: '2026-08-01' }, '2026-09-01'),
      false,
    );
    assert.equal(
      canIssueStatement({ status: 'ISSUED', visits: 5, period: '2026-08-01' }, '2026-09-01'),
      false,
    );
  });
});

describe('limitSummary', () => {
  test('says so plainly when no limit has been agreed', () => {
    assert.equal(
      limitSummary(util({ spent_cents: 117_150 })),
      'KSh 1,171.50 this month · no limit set',
    );
  });

  test('reports what is left', () => {
    assert.equal(
      limitSummary(util({ spent_cents: 50_000, cap_cents: 200_000 })),
      'KSh 500.00 of KSh 2,000.00 · KSh 1,500.00 left (25%)',
    );
  });

  test('reports the overspend as an amount, not a negative "left"', () => {
    assert.equal(
      limitSummary(util({ spent_cents: 280_000, cap_cents: 200_000 })),
      'KSh 2,800.00 of KSh 2,000.00 · KSh 800.00 over (140%)',
    );
  });
});

/* ── Treating a corporate patient ─────────────────────────────────────── */

const ctx = (over: Partial<EncounterSchemeContext> = {}): EncounterSchemeContext => ({
  member_id: 'm1', scheme_id: 's1', scheme_code: 'SRK',
  scheme_name: 'Stokman Rozen Kenya Ltd',
  employee_no: '646', relation: 'SELF', child_ref: null,
  member_name: 'ZAKIUS OWINO ABIERO', employee_name: 'ZAKIUS OWINO ABIERO',
  household_size: 6, covered_from: '1997-01-01', covered_to: null, covered: true,
  cap_cents: null, spent_cents: 0, remaining_cents: null, household_month_cents: 0,
  charge_id: null, charge_total_cents: null, charge_status: null,
  ...over,
});

const tariff = (over: Partial<SchemeTariff> = {}): SchemeTariff => ({
  service_id: 'sv1', code: 'CON-002',
  name: 'Outpatient consultation - Clinical Officer',
  category: 'Consultation & Registration', module: 'Core', unit: 'visit',
  cash_price_cents: 50_000, insurance_price_cents: 60_000,
  tariff_id: null, price_cents: null, bucket: null,
  effective_from: null, note: null, set_by_name: null,
  ...over,
});

describe('coverSummary', () => {
  test('names the company, then the person on its register', () => {
    assert.equal(
      coverSummary(ctx()),
      'Stokman Rozen Kenya Ltd · payroll 646',
    );
  });

  test('a dependant is described by whose account they draw on', () => {
    assert.equal(
      coverSummary(ctx({ relation: 'CHILD', child_ref: 'B', member_name: 'MERCY A' })),
      'Stokman Rozen Kenya Ltd · Child B of ZAKIUS OWINO ABIERO',
    );
  });

  test('lapsed cover is stated in capitals, not implied by an absence', () => {
    assert.match(coverSummary(ctx({ covered: false })), /NOT COVERED TODAY/);
  });

  test("the household's month is shown when there is one", () => {
    assert.equal(
      coverSummary(ctx({ household_month_cents: 124_00 })),
      'Stokman Rozen Kenya Ltd · payroll 646 · KSh 124.00 on this account this month',
    );
  });
});

describe('schemeMonthSummary', () => {
  test('no agreed ceiling says so rather than rendering as zero', () => {
    assert.equal(
      schemeMonthSummary(ctx({ spent_cents: 117_150 })),
      'KSh 1,171.50 this month · no limit set',
    );
  });

  test('reports the overspend as an amount', () => {
    assert.equal(
      schemeMonthSummary(ctx({ spent_cents: 130_000, cap_cents: 120_000 })),
      'KSh 1,300.00 of KSh 1,200.00 · KSh 100.00 over',
    );
  });
});

describe('untariffed', () => {
  test('a null price is uncovered; a zero price is covered at no charge', () => {
    const rows = [
      tariff({ code: 'A', price_cents: null }),
      tariff({ code: 'B', price_cents: 0, bucket: 'LAB' }),
      tariff({ code: 'C', price_cents: 10_000, bucket: 'CONSULTATION' }),
    ];
    assert.deepEqual(untariffed(rows).map((r) => r.code), ['A']);
  });
});

describe('tariffCoverage', () => {
  test('counts what the contract prices', () => {
    assert.deepEqual(
      tariffCoverage([
        tariff({ price_cents: 10_000 }),
        tariff({ price_cents: null }),
        tariff({ price_cents: null }),
        tariff({ price_cents: 0 }),
      ]),
      { covered: 2, total: 4, percent: 50 },
    );
  });

  test('an empty catalogue has no percentage rather than 0%', () => {
    assert.deepEqual(tariffCoverage([]), { covered: 0, total: 0, percent: null });
  });
});

describe('tariffDelta', () => {
  test("Stokman's consultation is 80% below the walk-in rate", () => {
    // The real figures: catalogue CON-002 is KES 500, the contract is KES 100.
    assert.equal(tariffDelta(tariff({ price_cents: 10_000 })), -80);
  });

  test('an uncovered service has no delta to report', () => {
    assert.equal(tariffDelta(tariff({ price_cents: null })), null);
  });

  test('a catalogue price of zero cannot be a denominator', () => {
    assert.equal(tariffDelta(tariff({ price_cents: 100, cash_price_cents: 0 })), null);
  });
});

describe('groupTariffsByCategory', () => {
  test('keeps catalogue order and does not split a repeated category', () => {
    const out = groupTariffsByCategory([
      tariff({ code: 'CON-002', category: 'Consultation & Registration' }),
      tariff({ code: 'CON-003', category: 'Consultation & Registration' }),
      tariff({ code: 'LAB-CHE-001', category: 'Laboratory - Clinical Chemistry' }),
    ]);
    assert.deepEqual(
      out.map((g) => [g.category, g.rows.length]),
      [['Consultation & Registration', 2], ['Laboratory - Clinical Chemistry', 1]],
    );
  });
});

describe('postSummary', () => {
  const posted = (over: Partial<PostedSchemeCharge> = {}): PostedSchemeCharge => ({
    charge_id: 'c1', total_cents: 60_000, over_limit: false,
    cap_cents: null, spent_cents: 60_000, remaining_cents: null,
    priced_count: 2, skipped_count: 0, ...over,
  });

  test('says what went on the bill', () => {
    assert.equal(
      postSummary(posted()),
      'KSh 600.00 posted to the scheme · 2 services priced',
    );
  });

  test('names what was deliberately left off — the 163-line failure', () => {
    // The August Stokman sheet had 163 pharmacy lines and one price. A skip
    // that says nothing is how that happens; this one always counts out loud.
    assert.equal(
      postSummary(posted({ skipped_count: 2 })),
      'KSh 600.00 posted to the scheme · 2 services priced · '
        + '2 not chargeable to the scheme (statutory, or priced at the pharmacy till)',
    );
  });

  test('singular for one service', () => {
    assert.match(postSummary(posted({ priced_count: 1 })), /1 service priced/);
  });

  test('warns when the visit crosses the company limit', () => {
    assert.match(postSummary(posted({ over_limit: true })), /past its monthly limit/);
  });
});
