/**
 * Tests for the pull endpoints.
 *
 * The property that matters most is the same one the webhook suite guards: a
 * request that fails authentication must not reach the data layer at all. Each
 * rejection test therefore asserts not just the status code but that the deps
 * were never called — a 401 that still queried the database would mean
 * unauthenticated input reaching the store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePosFetch, handlePosAck, type PullDeps, type PendingPrescription } from './pull-handler';
import { signBody } from './signature';

const SECRET = 'x'.repeat(48);
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function makeDeps(pending: PendingPrescription[] = []) {
  const calls = { fetchPending: 0, markDelivered: [] as string[], audit: 0 };
  const deps: PullDeps = {
    signingSecret: SECRET,
    async fetchPending(limit) { calls.fetchPending += 1; return pending.slice(0, limit); },
    async markDelivered(id) { calls.markDelivered.push(id); },
    async audit() { calls.audit += 1; },
  };
  return { deps, calls };
}

/** A correctly-signed request, unless overridden. */
function req(body: unknown, over: { secret?: string; timestamp?: string; signature?: string } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = over.timestamp ?? new Date().toISOString();
  const signature = over.signature ?? signBody(over.secret ?? SECRET, timestamp, raw);
  return new Request('https://clinic.example/api/integration/pos/outbox/fetch', {
    method: 'POST',
    headers: { 'X-Timestamp': timestamp, 'X-Signature': signature, 'content-type': 'application/json' },
    body: raw,
  });
}

const item = (outboxId: string): PendingPrescription => ({
  outboxId,
  prescriptionId: 'rx-' + outboxId.slice(0, 8),
  payload: { prescriptionId: 'rx', items: [] },
});

describe('fetch — authentication', () => {
  test('rejects a missing signature without touching the store', async () => {
    const { deps, calls } = makeDeps([item(ID_A)]);
    const bare = new Request('https://clinic.example/x', { method: 'POST', body: '{}' });
    const res = await handlePosFetch(bare, deps);
    assert.equal(res.status, 401);
    assert.equal(calls.fetchPending, 0);
  });

  test('rejects a forged signature without touching the store', async () => {
    const { deps, calls } = makeDeps([item(ID_A)]);
    const res = await handlePosFetch(req({ limit: 5 }, { secret: 'wrong-secret' }), deps);
    assert.equal(res.status, 401);
    assert.equal(calls.fetchPending, 0);
  });

  test('rejects a tampered body — the signature covers the raw bytes', async () => {
    const timestamp = new Date().toISOString();
    const signature = signBody(SECRET, timestamp, JSON.stringify({ limit: 1 }));
    const tampered = new Request('https://clinic.example/x', {
      method: 'POST',
      headers: { 'X-Timestamp': timestamp, 'X-Signature': signature },
      body: JSON.stringify({ limit: 100 }),
    });
    const { deps, calls } = makeDeps([item(ID_A)]);
    const res = await handlePosFetch(tampered, deps);
    assert.equal(res.status, 401);
    assert.equal(calls.fetchPending, 0);
  });

  test('rejects a stale timestamp outside the replay window', async () => {
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const { deps, calls } = makeDeps([item(ID_A)]);
    const res = await handlePosFetch(req({ limit: 5 }, { timestamp: old }), deps);
    assert.equal(res.status, 401);
    assert.equal(calls.fetchPending, 0);
  });

  test('rejects an unparseable timestamp rather than treating it as fresh', async () => {
    const { deps, calls } = makeDeps([]);
    const res = await handlePosFetch(req({ limit: 5 }, { timestamp: 'not-a-date' }), deps);
    assert.equal(res.status, 401);
    assert.equal(calls.fetchPending, 0);
  });
});

describe('fetch — behaviour', () => {
  test('returns pending work and does NOT mark anything delivered', async () => {
    // The core of at-least-once: reading must not consume.
    const { deps, calls } = makeDeps([item(ID_A), item(ID_B)]);
    const res = await handlePosFetch(req({ limit: 25 }), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.equal(body.prescriptions[0].outboxId, ID_A);
    assert.deepEqual(calls.markDelivered, []);
  });

  test('honours the requested limit', async () => {
    const { deps } = makeDeps([item(ID_A), item(ID_B)]);
    const res = await handlePosFetch(req({ limit: 1 }), deps);
    assert.equal((await res.json()).count, 1);
  });

  test('an empty body means the default page size, not an error', async () => {
    // A poller that sends no body is asking for "whatever is normal".
    const { deps } = makeDeps([item(ID_A)]);
    const res = await handlePosFetch(req(''), deps);
    assert.equal(res.status, 200);
  });

  test('refuses an out-of-range limit', async () => {
    for (const limit of [0, -1, 1000]) {
      const { deps, calls } = makeDeps([item(ID_A)]);
      const res = await handlePosFetch(req({ limit }), deps);
      assert.equal(res.status, 422, `limit ${limit} should be refused`);
      assert.equal(calls.fetchPending, 0);
    }
  });

  test('an empty queue is a 200 with nothing in it, not a 404', async () => {
    const { deps } = makeDeps([]);
    const res = await handlePosFetch(req({ limit: 25 }), deps);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).count, 0);
  });
});

describe('ack', () => {
  test('marks each id delivered', async () => {
    const { deps, calls } = makeDeps();
    const res = await handlePosAck(req({ outboxIds: [ID_A, ID_B] }), deps);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).acked, 2);
    assert.deepEqual(calls.markDelivered, [ID_A, ID_B]);
  });

  test('rejects a forged ack without marking anything', async () => {
    // The dangerous direction: a forged ack would silently discard a
    // prescription that never reached the pharmacy.
    const { deps, calls } = makeDeps();
    const res = await handlePosAck(req({ outboxIds: [ID_A] }, { secret: 'wrong' }), deps);
    assert.equal(res.status, 401);
    assert.deepEqual(calls.markDelivered, []);
  });

  test('refuses ids that are not uuids', async () => {
    const { deps, calls } = makeDeps();
    const res = await handlePosAck(req({ outboxIds: ['not-a-uuid'] }), deps);
    assert.equal(res.status, 422);
    assert.deepEqual(calls.markDelivered, []);
  });

  test('refuses an empty or oversized batch', async () => {
    for (const ids of [[], Array.from({ length: 101 }, () => ID_A)]) {
      const { deps, calls } = makeDeps();
      const res = await handlePosAck(req({ outboxIds: ids }), deps);
      assert.equal(res.status, 422);
      assert.deepEqual(calls.markDelivered, []);
    }
  });

  test('acking twice is not an error — a retried ack must not look like a fault', async () => {
    const { deps } = makeDeps();
    const first = await handlePosAck(req({ outboxIds: [ID_A] }), deps);
    const second = await handlePosAck(req({ outboxIds: [ID_A] }), deps);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  });

  test('a partial failure keeps the rows it already acked', async () => {
    // Sequential on purpose: the next poll should re-serve only what genuinely
    // did not land, not the whole batch.
    const marked: string[] = [];
    const deps: PullDeps = {
      signingSecret: SECRET,
      async fetchPending() { return []; },
      async markDelivered(id) {
        if (id === ID_B) throw new Error('db down');
        marked.push(id);
      },
      async audit() {},
    };
    await assert.rejects(() => handlePosAck(req({ outboxIds: [ID_A, ID_B] }), deps));
    assert.deepEqual(marked, [ID_A]);
  });
});
