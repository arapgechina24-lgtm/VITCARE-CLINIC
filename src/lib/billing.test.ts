import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEditCharges, canIssue, canTakePayment, canVoid, formatKes, isOpen,
  lineSubtotalCents, lineVatCents, outstandingCents, parseKesToCents,
  type InvoiceStatus,
} from './billing';

describe('formatKes', () => {
  test('formats whole and fractional shillings', () => {
    assert.equal(formatKes(0), 'KSh 0.00');
    assert.equal(formatKes(5), 'KSh 0.05');
    assert.equal(formatKes(50), 'KSh 0.50');
    assert.equal(formatKes(100000), 'KSh 1,000.00');
    assert.equal(formatKes(232386), 'KSh 2,323.86');
  });

  test('stays exact where float division would not', () => {
    // 1_000_005 / 100 is 10000.049999999999 in IEEE-754. Integer splitting is
    // the reason this reads 10,000.05 by rule rather than by rounding luck.
    assert.equal(formatKes(1_000_005), 'KSh 10,000.05');
    assert.equal(formatKes(999_999_999), 'KSh 9,999,999.99');
  });

  test('handles negatives and the symbol-less form', () => {
    assert.equal(formatKes(-2500), '-KSh 25.00');
    assert.equal(formatKes(2500, { symbol: false }), '25.00');
  });
});

describe('parseKesToCents', () => {
  test('accepts the shapes a cashier actually types', () => {
    assert.equal(parseKesToCents('1000'), 100000);
    assert.equal(parseKesToCents('1000.5'), 100050);
    assert.equal(parseKesToCents('1000.55'), 100055);
    assert.equal(parseKesToCents(' 1,234.50 '), 123450);
    assert.equal(parseKesToCents('0.05'), 5);
  });

  test('refuses anything that is not clean money', () => {
    // Each of these would otherwise become a payment for the wrong amount.
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '1..2', '.5', '5.']) {
      assert.equal(parseKesToCents(bad), null, `${JSON.stringify(bad)} should be rejected`);
    }
  });
});

describe('line arithmetic matches the server rounding', () => {
  test('VAT is rounded per line, half-up', () => {
    // 333 * 0.16 = 53.28 -> 53. Verified against the live trigger.
    assert.equal(lineVatCents({ quantity: 1, unit_price_cents: 333, vat_rate: 0.16 }), 53);
    assert.equal(lineVatCents({ quantity: 2, unit_price_cents: 100000, vat_rate: 0.16 }), 32000);
    assert.equal(lineVatCents({ quantity: 1, unit_price_cents: 50000, vat_rate: 0 }), 0);
  });

  test('subtotal is quantity times unit price', () => {
    assert.equal(lineSubtotalCents({ quantity: 3, unit_price_cents: 50000 }), 150000);
  });

  test('reproduces the invoice verified against the database', () => {
    // The probe invoice: 2 x 100000 @16% plus 1 x 333 @16%.
    const items = [
      { quantity: 2, unit_price_cents: 100000, vat_rate: 0.16 },
      { quantity: 1, unit_price_cents: 333, vat_rate: 0.16 },
    ];
    const subtotal = items.reduce((s, i) => s + lineSubtotalCents(i), 0);
    const vat = items.reduce((s, i) => s + lineVatCents(i), 0);
    assert.equal(subtotal, 200333);
    assert.equal(vat, 32053);
    assert.equal(subtotal + vat, 232386);
  });
});

describe('outstanding and action guards', () => {
  const inv = (over: Partial<{ status: InvoiceStatus; total_cents: number; paid_cents: number }> = {}) =>
    ({ status: 'ISSUED' as InvoiceStatus, total_cents: 100000, paid_cents: 0, ...over });

  test('outstanding never goes negative', () => {
    assert.equal(outstandingCents({ total_cents: 1000, paid_cents: 400 }), 600);
    assert.equal(outstandingCents({ total_cents: 1000, paid_cents: 1000 }), 0);
    // Overpayment is refused server-side, but a display must not show -200.
    assert.equal(outstandingCents({ total_cents: 1000, paid_cents: 1200 }), 0);
  });

  test('charges are editable only on a draft', () => {
    assert.equal(canEditCharges('DRAFT'), true);
    for (const s of ['ISSUED', 'PART_PAID', 'PAID', 'VOID'] as InvoiceStatus[]) {
      assert.equal(canEditCharges(s), false, `${s} must be frozen`);
    }
  });

  test('an empty draft cannot be issued', () => {
    assert.equal(canIssue('DRAFT', 0), false);
    assert.equal(canIssue('DRAFT', 1), true);
    assert.equal(canIssue('ISSUED', 3), false);
  });

  test('payment is offered only where something is owed', () => {
    assert.equal(canTakePayment(inv()), true);
    assert.equal(canTakePayment(inv({ paid_cents: 40000, status: 'PART_PAID' })), true);
    assert.equal(canTakePayment(inv({ paid_cents: 100000, status: 'PAID' })), false);
    assert.equal(canTakePayment(inv({ status: 'DRAFT' })), false);
    assert.equal(canTakePayment(inv({ status: 'VOID' })), false);
  });

  test('an invoice with money against it cannot be voided', () => {
    assert.equal(canVoid({ status: 'ISSUED', paid_cents: 0 }), true);
    assert.equal(canVoid({ status: 'PART_PAID', paid_cents: 1 }), false);
    assert.equal(canVoid({ status: 'VOID', paid_cents: 0 }), false);
  });

  test('isOpen means "still owes money"', () => {
    assert.deepEqual(
      (['DRAFT', 'ISSUED', 'PART_PAID', 'PAID', 'VOID'] as InvoiceStatus[]).filter(isOpen),
      ['ISSUED', 'PART_PAID'],
    );
  });
});
