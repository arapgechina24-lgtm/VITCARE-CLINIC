/**
 * The pricing rule, tested against the facility's real catalogue values.
 *
 * These are transcriptions of billing_price_cents / billing_price_basis and the
 * refusals in add_invoice_item. The numbers below were taken from the seeded
 * catalogue and verified against the live database in a rolled-back
 * transaction, so a failure here means the mirror has drifted from the server —
 * which is the only thing this file is for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeBlockReason, groupByCategory, isConditional, moduleLabel,
  priceBasisFor, priceForPayer, searchServices,
  type CatalogueService,
} from './catalogue';

/** CON-002, Outpatient consultation — Clinical Officer. SHA covers it. */
const CONSULT = { cash: 50_000, ins: 60_000, sha: 'Covered' } as const;
/** OUT-003, Corporate wellness day. SHA does not cover it. */
const CORPORATE = { cash: 6_000_000, ins: 7_200_000, sha: 'Not covered' } as const;

describe('priceForPayer', () => {
  test('a cash walk-in pays the cash column', () => {
    assert.equal(priceForPayer('CASH', CONSULT.sha, CONSULT.cash, CONSULT.ins), 50_000);
    assert.equal(priceForPayer('CASH', CORPORATE.sha, CORPORATE.cash, CORPORATE.ins), 6_000_000);
  });

  test('an insurer pays the credit tariff — the 20% uplift, never the cash rate', () => {
    // This is the defect 0025 fixed: before it, lines were priced before the
    // payer was known and an insurer was invoiced at 50,000.
    assert.equal(priceForPayer('INSURER', CONSULT.sha, CONSULT.cash, CONSULT.ins), 60_000);
    assert.equal(priceForPayer('INSURER', CORPORATE.sha, CORPORATE.cash, CORPORATE.ins), 7_200_000);
  });

  test('an SHA member is charged nothing for a covered service', () => {
    assert.equal(priceForPayer('SHA', 'Covered', CONSULT.cash, CONSULT.ins), 0);
  });

  test('an SHA member pays the CASH rate for anything not covered, never the uplift', () => {
    // Deliberate: the credit tariff is for schemes settling on invoice. An SHA
    // member paying out of pocket must not pay more than a walk-in would.
    for (const sha of ['Partial', 'Not covered', 'Free'] as const) {
      assert.equal(priceForPayer('SHA', sha, CONSULT.cash, CONSULT.ins), 50_000, sha);
    }
  });

  test('a zero-priced service is zero for every payer', () => {
    for (const payer of ['CASH', 'SHA', 'INSURER'] as const) {
      assert.equal(priceForPayer(payer, 'Free', 0, 0), 0, payer);
    }
  });
});

describe('priceBasisFor', () => {
  test('records which column produced the figure', () => {
    assert.equal(priceBasisFor('CASH', 'Covered'), 'CASH');
    assert.equal(priceBasisFor('INSURER', 'Covered'), 'INSURANCE');
    assert.equal(priceBasisFor('SHA', 'Covered'), 'SHA_COVERED');
    assert.equal(priceBasisFor('SHA', 'Partial'), 'CASH');
  });

  test('a zero on an SHA invoice is distinguishable from a typed zero', () => {
    // The whole reason the column exists: both are 0, only one is explainable.
    assert.equal(priceForPayer('SHA', 'Covered', CONSULT.cash, CONSULT.ins), 0);
    assert.equal(priceBasisFor('SHA', 'Covered'), 'SHA_COVERED');
    assert.notEqual(priceBasisFor('CASH', 'Covered'), 'SHA_COVERED');
  });
});

const svc = (over: Partial<CatalogueService> = {}) => ({
  code: 'CON-002',
  billable: true,
  active: true,
  module: 'Core',
  effective_from: '2026-09-01',
  billing_notes: null,
  ...over,
});

describe('chargeBlockReason', () => {
  test('a chargeable service has no reason to refuse', () => {
    assert.equal(chargeBlockReason(svc(), '2026-09-01'), null);
    assert.equal(chargeBlockReason(svc(), '2027-01-15'), null);
  });

  test('a statutory service quotes the catalogue back', () => {
    const reason = chargeBlockReason(
      svc({
        code: 'MCH-006', billable: false,
        billing_notes: 'Government commodity - MUST NOT be charged. Report doses via DHIS2/KHIS.',
      }),
      '2026-09-01',
    );
    assert.match(reason ?? '', /MUST NOT be charged/);
  });

  test('a statutory service with no note still refuses', () => {
    const reason = chargeBlockReason(svc({ billable: false }), '2026-09-01');
    assert.match(reason ?? '', /must not be charged/i);
  });

  test('an inactive conditional module names the module', () => {
    const reason = chargeBlockReason(
      svc({ code: 'IMG-010', active: false, module: 'Conditional - Radiology' }),
      '2026-09-01',
    );
    assert.match(reason ?? '', /Radiology/);
    assert.doesNotMatch(reason ?? '', /Conditional/);
  });

  test('a price that is not yet effective is refused, not silently charged', () => {
    // Catalogue v1.0 is dated 01-Sep-2026 and marked DRAFT pending board
    // approval. Billing a draft price early is the failure this prevents.
    const reason = chargeBlockReason(svc(), '2026-08-21');
    assert.match(reason ?? '', /2026-09-01/);
  });

  test('the reasons are checked in the same order the server checks them', () => {
    // Non-billable wins over inactive wins over not-yet-effective, so the
    // message matches whatever add_invoice_item would have raised.
    const reason = chargeBlockReason(
      svc({ billable: false, active: false, billing_notes: 'Statutory.' }),
      '2020-01-01',
    );
    assert.equal(reason, 'Statutory.');
  });
});

describe('moduleLabel', () => {
  test('strips the Conditional prefix and leaves Core alone', () => {
    assert.equal(moduleLabel('Conditional - Imaging'), 'Imaging');
    assert.equal(moduleLabel('Conditional - Visiting Specialist'), 'Visiting Specialist');
    assert.equal(moduleLabel('Core'), 'Core');
    assert.equal(isConditional('Conditional - Dental'), true);
    assert.equal(isConditional('Core'), false);
  });
});

describe('searchServices', () => {
  const rows = [
    { code: 'LAB-MIC-005', name: 'Urine microscopy, culture & sensitivity', category: 'Laboratory - Microbiology & Parasitology', sub_category: 'Culture' },
    { code: 'LAB-MIC-004', name: 'Urinalysis - dipstick & microscopy', category: 'Laboratory - Microbiology & Parasitology', sub_category: 'Urinalysis' },
    { code: 'CON-002', name: 'Outpatient consultation - Clinical Officer', category: 'Consultation & Registration', sub_category: 'Outpatient' },
  ];

  test('every term must match, so typing narrows rather than widens', () => {
    // "urine culture" finds the culture even though the words are not adjacent.
    const hits = searchServices(rows, 'urine culture');
    assert.deepEqual(hits.map((r) => r.code), ['LAB-MIC-005']);
  });

  test('matches on code and on category', () => {
    assert.equal(searchServices(rows, 'CON-002').length, 1);
    assert.equal(searchServices(rows, 'microbiology').length, 2);
  });

  test('an empty query returns everything, untouched', () => {
    assert.equal(searchServices(rows, '   ').length, 3);
  });
});

describe('groupByCategory', () => {
  test('groups without reordering within a group', () => {
    const grouped = groupByCategory([
      { category: 'A', n: 1 }, { category: 'B', n: 2 }, { category: 'A', n: 3 },
    ]);
    assert.deepEqual(grouped.map(([k, v]) => [k, v.map((x) => x.n)]), [['A', [1, 3]], ['B', [2]]]);
  });

  test('an uncategorised service is not dropped', () => {
    const grouped = groupByCategory([{ category: null }]);
    assert.deepEqual(grouped.map(([k]) => k), ['Other']);
  });
});
