import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canCancel, isClosed, needsAttention, pharmacyStats, waitingMinutes,
  type DeliveryState, type PharmacyRow, type PrescriptionStatus,
} from './pharmacy';

let seq = 0;
function rx(over: Partial<PharmacyRow> = {}): PharmacyRow {
  seq += 1;
  return {
    id: `rx${seq}`,
    patient_id: `p${seq}`,
    patient_full_name: 'Test Patient',
    patient_mrn: 'VC-20260817-000001',
    prescriber_name: 'Dr. Test',
    status: 'PENDING',
    payer: 'CASH',
    total_amount_cents: null,
    item_count: 2,
    dispensed_item_count: 0,
    note: null,
    created_at: '2026-08-17T06:00:00Z',
    updated_at: '2026-08-17T06:00:00Z',
    delivery_state: 'DELIVERED',
    delivery_attempts: 1,
    delivery_next_attempt_at: null,
    delivery_last_error: null,
    ...over,
  };
}

describe('cancel guard mirrors cancel_prescription', () => {
  test('refused once the patient physically has the medicine', () => {
    assert.equal(canCancel('DISPENSED'), false);
    assert.equal(canCancel('COLLECTED'), false);
  });

  test('allowed while it is still only a piece of paper', () => {
    for (const s of ['PENDING', 'PRICED', 'OUT_OF_STOCK', 'PARTIAL', 'SUBSTITUTED'] as PrescriptionStatus[]) {
      assert.equal(canCancel(s), true, `${s} should be cancellable`);
    }
  });

  test('already cancelled is not offered again', () => {
    assert.equal(canCancel('CANCELLED'), false);
  });
});

describe('needsAttention is deliberately narrow', () => {
  test('normal traffic is not an alert', () => {
    // The failure mode being designed against: an attention list that fills
    // with ordinary PENDING rows is one nobody reads.
    assert.equal(needsAttention({ status: 'PENDING', delivery_state: 'DELIVERED' }), false);
    assert.equal(needsAttention({ status: 'PRICED', delivery_state: 'DELIVERED' }), false);
    assert.equal(needsAttention({ status: 'DISPENSED', delivery_state: 'DELIVERED' }), false);
  });

  test('a prescription that never reached the pharmacy is an alert', () => {
    // These two are the reason delivery state is carried separately: on status
    // alone they are indistinguishable from a pharmacy that is merely busy.
    assert.equal(needsAttention({ status: 'PENDING', delivery_state: 'FAILED' }), true);
    assert.equal(needsAttention({ status: 'PENDING', delivery_state: 'NONE' }), true);
  });

  test('retrying is not yet an alert — the outbox is doing its job', () => {
    assert.equal(needsAttention({ status: 'PENDING', delivery_state: 'RETRYING' }), false);
    assert.equal(needsAttention({ status: 'PENDING', delivery_state: 'QUEUED' }), false);
  });

  test('out of stock always needs a human', () => {
    assert.equal(needsAttention({ status: 'OUT_OF_STOCK', delivery_state: 'DELIVERED' }), true);
  });

  test('a closed prescription is never an alert, whatever the outbox says', () => {
    for (const d of ['FAILED', 'NONE'] as DeliveryState[]) {
      assert.equal(needsAttention({ status: 'COLLECTED', delivery_state: d }), false);
      assert.equal(needsAttention({ status: 'CANCELLED', delivery_state: d }), false);
    }
  });
});

describe('waitingMinutes', () => {
  test('measures against the clock it is given', () => {
    const now = new Date('2026-08-17T06:45:00Z').getTime();
    assert.equal(waitingMinutes({ created_at: '2026-08-17T06:00:00Z' }, now), 45);
  });

  test('never reports negative for a clock skew', () => {
    const now = new Date('2026-08-17T05:00:00Z').getTime();
    assert.equal(waitingMinutes({ created_at: '2026-08-17T06:00:00Z' }, now), 0);
  });
});

describe('pharmacyStats', () => {
  test('counts only open prescriptions', () => {
    const s = pharmacyStats([
      rx({ status: 'PENDING' }),
      rx({ status: 'PRICED' }),
      rx({ status: 'DISPENSED' }),
      rx({ status: 'OUT_OF_STOCK' }),
      rx({ status: 'COLLECTED' }),
      rx({ status: 'CANCELLED' }),
    ]);
    assert.equal(s.open, 4);
    assert.equal(s.awaitingPharmacy, 2);
    assert.equal(s.readyToCollect, 1);
    assert.equal(s.outOfStock, 1);
  });

  test('undelivered counts what never got there, and excludes closed rows', () => {
    const s = pharmacyStats([
      rx({ status: 'PENDING', delivery_state: 'FAILED' }),
      rx({ status: 'PENDING', delivery_state: 'NONE' }),
      rx({ status: 'PENDING', delivery_state: 'RETRYING' }),
      rx({ status: 'COLLECTED', delivery_state: 'FAILED' }),
    ]);
    assert.equal(s.undelivered, 2);
  });

  test('isClosed marks exactly the two terminal states', () => {
    assert.deepEqual(
      (['PENDING', 'PRICED', 'DISPENSED', 'COLLECTED', 'OUT_OF_STOCK', 'PARTIAL', 'SUBSTITUTED', 'CANCELLED'] as PrescriptionStatus[])
        .filter(isClosed),
      ['COLLECTED', 'CANCELLED'],
    );
  });
});
