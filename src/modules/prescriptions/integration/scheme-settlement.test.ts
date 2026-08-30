/**
 * The interlock that stops one dispensing becoming two bills.
 *
 * A settlement instruction that a receiver silently ignores is the worst
 * outcome this integration can produce: the farm is billed on its monthly
 * statement AND the patient is charged at the window, with nothing looking
 * wrong on either document. The version stamp is what makes that unreachable,
 * so these tests are about the stamp as much as the block it guards.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreatePrescriptionSchema,
  PrescriptionStatusEventSchema,
  SchemeSettlementSchema,
  BASELINE_CONTRACT_VERSION,
  CONTRACT_VERSION,
  isSupportedVersion,
  versionFor,
} from './prescription-contract';

const SETTLEMENT = {
  memberId: '44444444-4444-4444-8444-444444444444',
  schemeCode: 'SRK',
  schemeName: 'Stokman Rose Kenya',
  memberNo: 'SR 9883',
};

const rx = (over: Record<string, unknown> = {}) => ({
  contractVersion: BASELINE_CONTRACT_VERSION,
  prescriptionId: '11111111-1111-4111-8111-111111111111',
  fulfillmentSiteId: '22222222-2222-4222-8222-222222222222',
  patient: { mrn: 'MRN-1', fullName: 'Jane Wanjiru', payer: 'CASH' },
  prescriber: { userId: '33333333-3333-4333-8333-333333333333', name: 'Dr Otieno' },
  encounterId: '55555555-5555-4555-8555-555555555555',
  items: [{
    itemId: '66666666-6666-4666-8666-666666666666',
    drugName: 'Amoxicillin 500mg',
    dose: '1 capsule',
    frequency: 'TDS',
    quantity: 21,
    substitutionAllowed: false,
  }],
  issuedAt: '2026-08-20T09:00:00.000Z',
  ...over,
});

const event = (over: Record<string, unknown> = {}) => ({
  contractVersion: BASELINE_CONTRACT_VERSION,
  eventId: '77777777-7777-4777-8777-777777777777',
  prescriptionId: '11111111-1111-4111-8111-111111111111',
  status: 'DISPENSED',
  occurredAt: '2026-08-20T10:00:00.000Z',
  ...over,
});

describe('an ordinary prescription is untouched', () => {
  test('it still validates at the baseline version', () => {
    assert.equal(CreatePrescriptionSchema.safeParse(rx()).success, true);
  });

  test('and versionFor keeps it there', () => {
    // If this ever returned the newest version, every routine prescription in
    // the facility would be withheld from a till mid-rollout.
    assert.equal(versionFor({}), BASELINE_CONTRACT_VERSION);
  });
});

describe('a settlement cannot travel under a version that ignores it', () => {
  test('settlement stamped at the baseline is refused', () => {
    const parsed = CreatePrescriptionSchema.safeParse(
      rx({ settlement: SETTLEMENT, contractVersion: BASELINE_CONTRACT_VERSION }),
    );
    assert.equal(parsed.success, false);
  });

  test('the refusal names the version field, not the settlement', () => {
    // The fix is to stamp it correctly, so the error has to point at the stamp.
    const parsed = CreatePrescriptionSchema.safeParse(
      rx({ settlement: SETTLEMENT, contractVersion: BASELINE_CONTRACT_VERSION }),
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(parsed.error?.issues[0]?.path, ['contractVersion']);
  });

  test('settlement stamped at the current version is accepted', () => {
    const parsed = CreatePrescriptionSchema.safeParse(
      rx({ settlement: SETTLEMENT, contractVersion: CONTRACT_VERSION }),
    );
    assert.equal(parsed.success, true);
  });

  test('versionFor stamps a settled prescription correctly', () => {
    assert.equal(versionFor({ settlement: SETTLEMENT }), CONTRACT_VERSION);
    const parsed = CreatePrescriptionSchema.safeParse(
      rx({ settlement: SETTLEMENT, contractVersion: versionFor({ settlement: SETTLEMENT }) }),
    );
    assert.equal(parsed.success, true);
  });

  test('a till predating the feature would reject the stamp outright', () => {
    // Reproduces the OLD receiver, which validated the version with a literal.
    // This is the property the whole rollout rests on: such a till never sees
    // the prescription at all, so it cannot dispense it and ask for money.
    const oldReceiverAccepts = (v: string) => v === BASELINE_CONTRACT_VERSION;
    assert.equal(oldReceiverAccepts(CONTRACT_VERSION), false);
  });
});

describe('the settlement block itself', () => {
  test('a member number is required — a farm reconciles on it', () => {
    const { memberNo, ...withoutMemberNo } = SETTLEMENT;
    void memberNo;
    assert.equal(SchemeSettlementSchema.safeParse(withoutMemberNo).success, false);
  });

  test('an empty member number is not a member number', () => {
    assert.equal(SchemeSettlementSchema.safeParse({ ...SETTLEMENT, memberNo: '' }).success, false);
  });

  test('it carries no price — drug prices live in the POS catalogue only', () => {
    const parsed = SchemeSettlementSchema.safeParse({ ...SETTLEMENT, priceCents: 5000 });
    assert.equal(parsed.success, true);
    assert.equal('priceCents' in (parsed.data ?? {}), false);
  });
});

describe('the return leg carries what the farm owes', () => {
  test('a scheme-settled event at the baseline version is refused', () => {
    // An un-upgraded clinic would drop the block and never bill the farm.
    const parsed = PrescriptionStatusEventSchema.safeParse(event({
      totalAmountCents: 0,
      schemeSettled: { amountCents: 116000, invoiceNo: 'INV-42', memberId: SETTLEMENT.memberId },
    }));
    assert.equal(parsed.success, false);
  });

  test('and is accepted at the current one', () => {
    const parsed = PrescriptionStatusEventSchema.safeParse(event({
      contractVersion: CONTRACT_VERSION,
      totalAmountCents: 0,
      schemeSettled: { amountCents: 116000, invoiceNo: 'INV-42', memberId: SETTLEMENT.memberId },
    }));
    assert.equal(parsed.success, true);
  });

  test('an ordinary dispensing still reports at the baseline', () => {
    assert.equal(
      PrescriptionStatusEventSchema.safeParse(event({ totalAmountCents: 116000 })).success,
      true,
    );
  });

  test('a zero-value settlement is representable, and distinct from absent', () => {
    // A prescription cancelled at the counter after the shelf was checked.
    // Collapsing it to "no settlement" would lose the fact that the till was
    // told not to collect.
    const parsed = PrescriptionStatusEventSchema.safeParse(event({
      contractVersion: CONTRACT_VERSION,
      totalAmountCents: 0,
      schemeSettled: { amountCents: 0, invoiceNo: 'INV-43', memberId: SETTLEMENT.memberId },
    }));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.schemeSettled?.amountCents, 0);
  });

  test('an invoice number is required — the figure must be traceable', () => {
    const parsed = PrescriptionStatusEventSchema.safeParse(event({
      contractVersion: CONTRACT_VERSION,
      schemeSettled: { amountCents: 116000, memberId: SETTLEMENT.memberId },
    }));
    assert.equal(parsed.success, false);
  });
});

describe('version support', () => {
  test('both shipped versions are supported by this build', () => {
    assert.equal(isSupportedVersion(BASELINE_CONTRACT_VERSION), true);
    assert.equal(isSupportedVersion(CONTRACT_VERSION), true);
  });

  test('a version this build has never heard of is not', () => {
    assert.equal(isSupportedVersion('0.9.0'), false);
    assert.equal(isSupportedVersion('9.9.9'), false);
    assert.equal(isSupportedVersion(''), false);
  });
});
