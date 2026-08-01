/**
 * Tests for the CLINIC → POS direction: request signing, the retry/permanence
 * classification, and the outbox drain.
 *
 * The stakes here are a patient's drugs going missing in transit. The two
 * properties worth defending are (a) a transient POS outage must never
 * discard a prescription, and (b) a prescription POS has already accepted
 * must never be silently re-queued as a different order — which is what the
 * Idempotency-Key assertion below is really protecting.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  PosClient,
  drainOutbox,
  signBody,
  type OutboxRow,
  type OutboxStore,
  type PosClientConfig,
} from './pos-client-outbox';
import { CONTRACT_VERSION, type CreatePrescription } from './prescription-contract';

const SECRET = 'shared-secret-32-bytes-minimum-for-real-use';
const PRESCRIPTION_ID = '11111111-1111-4111-8111-111111111111';

const CONFIG: PosClientConfig = {
  baseUrl: 'https://pos.vitcare.test/api',
  signingSecret: SECRET,
  timeoutMs: 2000,
};

function validPrescription(over: Partial<CreatePrescription> = {}): CreatePrescription {
  return {
    contractVersion: CONTRACT_VERSION,
    prescriptionId: PRESCRIPTION_ID,
    fulfillmentSiteId: '33333333-3333-4333-8333-333333333333',
    encounterId: '44444444-4444-4444-8444-444444444444',
    issuedAt: new Date().toISOString(),
    patient: { mrn: 'VC-20260801-abc123', fullName: 'Test Patient', payer: 'CASH' },
    prescriber: { userId: '55555555-5555-4555-8555-555555555555', name: 'Dr. Test' },
    items: [
      {
        itemId: '66666666-6666-4666-8666-666666666666',
        drugName: 'Amoxicillin',
        dose: '1 capsule',
        frequency: 'TDS',
        quantity: 15,
        substitutionAllowed: false,
      },
    ],
    ...over,
  } as CreatePrescription;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Captures the outgoing request and replies with a chosen status. */
function stubFetch(status: number | 'network-error') {
  const captured: { url?: string; init?: RequestInit } = {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    if (status === 'network-error') throw new Error('ECONNREFUSED');
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return captured;
}

describe('signBody', () => {
  test('produces a signature the receiving side recomputes identically', () => {
    // Both directions of the contract sign `${timestamp}.${rawBody}`. If these
    // two ever drift apart, every cross-system call 401s — so pin it here.
    const timestamp = new Date().toISOString();
    const rawBody = JSON.stringify({ hello: 'world' });
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');

    assert.equal(signBody(SECRET, timestamp, rawBody), expected);
  });

  test('a different secret yields a different signature', () => {
    const timestamp = new Date().toISOString();
    assert.notEqual(signBody(SECRET, timestamp, '{}'), signBody('other-secret', timestamp, '{}'));
  });
});

describe('PosClient.sendPrescription — outgoing request shape', () => {
  test('sends the headers the POS contract requires, keyed for idempotent retry', async () => {
    const captured = stubFetch(202);
    const payload = validPrescription();
    const result = await new PosClient(CONFIG).sendPrescription(payload);

    assert.equal(result.ok, true);
    assert.equal(captured.url, 'https://pos.vitcare.test/api/prescriptions');

    const headers = captured.init!.headers as Record<string, string>;
    assert.equal(headers['X-Contract-Version'], CONTRACT_VERSION);
    assert.equal(
      headers['Idempotency-Key'],
      PRESCRIPTION_ID,
      'POS dedupes on this — it must be the stable prescription id, not a fresh uuid per attempt',
    );

    // The signature must cover exactly the bytes actually transmitted.
    const sentBody = captured.init!.body as string;
    assert.equal(headers['X-Signature'], signBody(SECRET, headers['X-Timestamp'], sentBody));
  });

  test('rejects an invalid payload as permanent, without hitting the network', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;

    const result = await new PosClient(CONFIG).sendPrescription(
      validPrescription({ items: [] }), // contract requires at least one item
    );

    assert.equal(result.ok, false);
    assert.equal(result.permanent, true, 'a malformed payload will never succeed on retry');
    assert.equal(called, false, 'must validate before spending a network call');
  });
});

describe('PosClient.sendPrescription — retry classification', () => {
  const cases: Array<{ status: number | 'network-error'; ok: boolean; permanent: boolean; why: string }> = [
    { status: 202, ok: true, permanent: false, why: 'accepted' },
    { status: 400, ok: false, permanent: true, why: 'our payload is wrong; retrying cannot help' },
    { status: 409, ok: false, permanent: true, why: 'POS already has it' },
    { status: 408, ok: false, permanent: false, why: 'timeout is transient' },
    { status: 429, ok: false, permanent: false, why: 'rate limit clears' },
    { status: 500, ok: false, permanent: false, why: 'POS is down, not wrong' },
    { status: 503, ok: false, permanent: false, why: 'POS restarting' },
    { status: 'network-error', ok: false, permanent: false, why: 'unreachable, not rejected' },
  ];

  for (const { status, ok, permanent, why } of cases) {
    test(`${status} → ok=${ok}, permanent=${permanent} (${why})`, async () => {
      stubFetch(status);
      const result = await new PosClient(CONFIG).sendPrescription(validPrescription());
      assert.equal(result.ok, ok);
      assert.equal(result.permanent, permanent);
    });
  }
});

// ── Outbox drain ──────────────────────────────────────────────────────────
interface StoreCalls {
  delivered: string[];
  failed: Array<{ id: string; error: string }>;
  rescheduled: Array<{ id: string; attempts: number; delayMs: number }>;
}

function makeStore(rows: OutboxRow[]): { store: OutboxStore; calls: StoreCalls } {
  const calls: StoreCalls = { delivered: [], failed: [], rescheduled: [] };
  const store: OutboxStore = {
    async claimBatch() {
      return rows;
    },
    async markDelivered(id) {
      calls.delivered.push(id);
    },
    async reschedule(id, attempts, nextAttemptAt) {
      calls.rescheduled.push({ id, attempts, delayMs: nextAttemptAt.getTime() - Date.now() });
    },
    async markFailed(id, error) {
      calls.failed.push({ id, error });
    },
  };
  return { store, calls };
}

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 'outbox-1',
  prescriptionId: PRESCRIPTION_ID,
  payload: validPrescription(),
  attempts: 0,
  ...over,
});

describe('drainOutbox', () => {
  test('marks a successfully delivered row as delivered', async () => {
    stubFetch(202);
    const { store, calls } = makeStore([row()]);
    const result = await drainOutbox(store, new PosClient(CONFIG));

    assert.deepEqual(result, { delivered: 1, retried: 0, failed: 0 });
    assert.deepEqual(calls.delivered, ['outbox-1']);
  });

  test('a POS outage reschedules rather than discarding the prescription', async () => {
    stubFetch(503);
    const { store, calls } = makeStore([row({ attempts: 0 })]);
    const result = await drainOutbox(store, new PosClient(CONFIG));

    assert.deepEqual(result, { delivered: 0, retried: 1, failed: 0 });
    assert.deepEqual(calls.failed, [], 'a transient outage must never drop the row');
    assert.equal(calls.rescheduled[0].attempts, 1);
    // First backoff is one minute.
    assert.ok(
      Math.abs(calls.rescheduled[0].delayMs - 60_000) < 2_000,
      `expected ~60s backoff, got ${calls.rescheduled[0].delayMs}ms`,
    );
  });

  test('backoff grows exponentially but is capped at one hour', async () => {
    stubFetch(503);
    const { store, calls } = makeStore([row({ attempts: 6 })]); // → attempt 7: 60s * 2^6 = 64 min
    await drainOutbox(store, new PosClient(CONFIG));

    assert.equal(calls.rescheduled[0].attempts, 7);
    assert.ok(
      Math.abs(calls.rescheduled[0].delayMs - 3_600_000) < 2_000,
      `expected the 1h ceiling, got ${calls.rescheduled[0].delayMs}ms`,
    );
  });

  test('gives up after the attempt ceiling instead of retrying forever', async () => {
    stubFetch(503);
    const { store, calls } = makeStore([row({ attempts: 7 })]); // → attempt 8 == MAX_ATTEMPTS
    const result = await drainOutbox(store, new PosClient(CONFIG));

    assert.deepEqual(result, { delivered: 0, retried: 0, failed: 1 });
    assert.equal(calls.failed[0].id, 'outbox-1');
    assert.deepEqual(calls.rescheduled, []);
  });

  test('a permanent rejection fails fast without burning the retry budget', async () => {
    stubFetch(400);
    const { store, calls } = makeStore([row({ attempts: 0 })]);
    const result = await drainOutbox(store, new PosClient(CONFIG));

    assert.deepEqual(result, { delivered: 0, retried: 0, failed: 1 });
    assert.deepEqual(calls.rescheduled, []);
  });

  test('processes a mixed batch independently and reports accurate counts', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return new Response('{}', { status: 202 }); // delivered
      if (call === 2) return new Response('{}', { status: 503 }); // retried
      return new Response('{}', { status: 400 }); // failed
    }) as unknown as typeof fetch;

    const { store, calls } = makeStore([
      row({ id: 'a' }),
      row({ id: 'b' }),
      row({ id: 'c' }),
    ]);
    const result = await drainOutbox(store, new PosClient(CONFIG));

    assert.deepEqual(result, { delivered: 1, retried: 1, failed: 1 });
    assert.deepEqual(calls.delivered, ['a']);
    assert.equal(calls.rescheduled[0].id, 'b');
    assert.equal(calls.failed[0].id, 'c');
  });
});
