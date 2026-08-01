/**
 * Tests for the POS → CLINIC webhook receiver.
 *
 * This endpoint is the one route in the clinic that is reachable WITHOUT a
 * staff session (POS is a machine, not a logged-in user), so the HMAC
 * signature, the replay window and the state machine are the entire security
 * boundary. Several tests below assert not just the status code but that
 * NO dependency was touched on a rejected request — a 401 that still hit the
 * database would mean unauthenticated input reaching our data layer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { handlePosWebhook, type WebhookDeps } from './webhook-handler';
import { CONTRACT_VERSION, type PrescriptionStatus, type PrescriptionStatusEvent } from './prescription-contract';

const SECRET = 'shared-secret-32-bytes-minimum-for-real-use';
const PRESCRIPTION_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';

const sign = (secret: string, timestamp: string, rawBody: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

function makeEvent(over: Partial<PrescriptionStatusEvent> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    prescriptionId: PRESCRIPTION_ID,
    status: 'PRICED',
    occurredAt: new Date().toISOString(),
    totalAmountCents: 45000,
    ...over,
  };
}

interface Recorder {
  deps: WebhookDeps;
  seen: {
    hasProcessedEvent: string[];
    getPrescriptionStatus: string[];
    applied: PrescriptionStatusEvent[];
    audited: Array<{ action: string; prescriptionId: string }>;
  };
}

function makeDeps(opts: { processed?: boolean; currentStatus?: PrescriptionStatus | null } = {}): Recorder {
  const seen: Recorder['seen'] = { hasProcessedEvent: [], getPrescriptionStatus: [], applied: [], audited: [] };
  const deps: WebhookDeps = {
    signingSecret: SECRET,
    async hasProcessedEvent(eventId) {
      seen.hasProcessedEvent.push(eventId);
      return opts.processed ?? false;
    },
    async getPrescriptionStatus(prescriptionId) {
      seen.getPrescriptionStatus.push(prescriptionId);
      return opts.currentStatus === undefined ? 'PENDING' : opts.currentStatus;
    },
    async applyStatusEvent(event) {
      seen.applied.push(event);
    },
    async audit(action, prescriptionId) {
      seen.audited.push({ action, prescriptionId });
    },
  };
  return { deps, seen };
}

/** Builds a request. Pass `signature`/`timestamp` explicitly to forge or omit them. */
function makeRequest(
  body: unknown,
  opts: { timestamp?: string | null; signature?: string | null; rawBodyOverride?: string } = {},
): Request {
  const rawBody = opts.rawBodyOverride ?? JSON.stringify(body);
  const timestamp = opts.timestamp === undefined ? new Date().toISOString() : opts.timestamp;
  const signature =
    opts.signature === undefined ? sign(SECRET, timestamp ?? '', rawBody) : opts.signature;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (timestamp !== null) headers.set('X-Timestamp', timestamp);
  if (signature !== null) headers.set('X-Signature', signature);

  return new Request('https://clinic.test/api/integration/pos/prescription-status', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

describe('handlePosWebhook — authentication', () => {
  test('rejects a request with no signature headers, without touching the database', async () => {
    const { deps, seen } = makeDeps();
    const res = await handlePosWebhook(makeRequest(makeEvent(), { timestamp: null, signature: null }), deps);

    assert.equal(res.status, 401);
    assert.deepEqual(seen.hasProcessedEvent, [], 'must not query the DB before authenticating');
    assert.deepEqual(seen.applied, []);
  });

  test('rejects when only the timestamp is present', async () => {
    const { deps } = makeDeps();
    const res = await handlePosWebhook(makeRequest(makeEvent(), { signature: null }), deps);
    assert.equal(res.status, 401);
  });

  test('rejects a forged signature, without touching the database', async () => {
    const { deps, seen } = makeDeps();
    const res = await handlePosWebhook(
      makeRequest(makeEvent(), { signature: 'f'.repeat(64) }),
      deps,
    );

    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'bad signature');
    assert.deepEqual(seen.hasProcessedEvent, [], 'must not query the DB on a bad signature');
  });

  test('rejects a signature signed with the wrong secret', async () => {
    const { deps } = makeDeps();
    const timestamp = new Date().toISOString();
    const body = JSON.stringify(makeEvent());
    const res = await handlePosWebhook(
      makeRequest(null, { timestamp, signature: sign('wrong-secret', timestamp, body), rawBodyOverride: body }),
      deps,
    );
    assert.equal(res.status, 401);
  });

  test('rejects a tampered body — signature is verified over the RAW bytes', async () => {
    const { deps, seen } = makeDeps();
    const timestamp = new Date().toISOString();
    const signedBody = JSON.stringify(makeEvent({ totalAmountCents: 45000 }));
    // Attacker keeps the valid signature but swaps the body for a cheaper total.
    const tamperedBody = JSON.stringify(makeEvent({ totalAmountCents: 1 }));

    const res = await handlePosWebhook(
      makeRequest(null, {
        timestamp,
        signature: sign(SECRET, timestamp, signedBody),
        rawBodyOverride: tamperedBody,
      }),
      deps,
    );

    assert.equal(res.status, 401);
    assert.deepEqual(seen.applied, [], 'tampered payload must never be applied');
  });

  test('a malformed short signature is rejected, not crashed on', async () => {
    // timingSafeEqual throws if the two buffers differ in length; the handler
    // guards with a length check first. Without that guard this would be an
    // unhandled throw — a trivial remote DoS on an unauthenticated endpoint.
    const { deps } = makeDeps();
    const res = await handlePosWebhook(makeRequest(makeEvent(), { signature: 'ab' }), deps);
    assert.equal(res.status, 401);
  });
});

describe('handlePosWebhook — replay protection', () => {
  test('rejects a timestamp older than the 5 minute window', async () => {
    const { deps, seen } = makeDeps();
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const res = await handlePosWebhook(makeRequest(makeEvent(), { timestamp: stale }), deps);

    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'stale timestamp');
    assert.deepEqual(seen.hasProcessedEvent, []);
  });

  test('rejects a timestamp too far in the future', async () => {
    const { deps } = makeDeps();
    const future = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    const res = await handlePosWebhook(makeRequest(makeEvent(), { timestamp: future }), deps);
    assert.equal(res.status, 401);
  });

  test('rejects an unparseable timestamp', async () => {
    const { deps } = makeDeps();
    const res = await handlePosWebhook(makeRequest(makeEvent(), { timestamp: 'not-a-date' }), deps);
    assert.equal(res.status, 401);
  });

  test('accepts a timestamp comfortably inside the window', async () => {
    const { deps } = makeDeps();
    const recent = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const res = await handlePosWebhook(makeRequest(makeEvent(), { timestamp: recent }), deps);
    assert.equal(res.status, 200);
  });
});

describe('handlePosWebhook — idempotency and state machine', () => {
  test('a replayed eventId is acknowledged but NOT re-applied', async () => {
    const { deps, seen } = makeDeps({ processed: true });
    const res = await handlePosWebhook(makeRequest(makeEvent()), deps);

    assert.equal(res.status, 200);
    assert.equal((await res.json()).deduped, true);
    assert.deepEqual(seen.applied, [], 'a duplicate must not be applied twice');
    assert.deepEqual(seen.audited, []);
  });

  test('returns 404 for a prescription the clinic does not know', async () => {
    const { deps, seen } = makeDeps({ currentStatus: null });
    const res = await handlePosWebhook(makeRequest(makeEvent()), deps);

    assert.equal(res.status, 404);
    assert.deepEqual(seen.applied, []);
  });

  test('returns 409 on an illegal transition rather than retrying forever', async () => {
    // COLLECTED is terminal — nothing may follow it.
    const { deps, seen } = makeDeps({ currentStatus: 'COLLECTED' });
    const res = await handlePosWebhook(makeRequest(makeEvent({ status: 'DISPENSED' })), deps);

    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /illegal transition/);
    assert.deepEqual(seen.applied, [], 'an illegal transition must not mutate state');
  });

  test('applies a legal transition and writes an audit entry', async () => {
    const { deps, seen } = makeDeps({ currentStatus: 'PENDING' });
    const event = makeEvent({ status: 'PRICED', totalAmountCents: 45000 });
    const res = await handlePosWebhook(makeRequest(event), deps);

    assert.equal(res.status, 200);
    assert.equal(seen.applied.length, 1);
    assert.equal(seen.applied[0].status, 'PRICED');
    assert.equal(seen.applied[0].totalAmountCents, 45000);
    assert.deepEqual(seen.audited, [{ action: 'prescription.priced', prescriptionId: PRESCRIPTION_ID }]);
  });

  test('carries per-line dispensing detail through to the data layer', async () => {
    const { deps, seen } = makeDeps({ currentStatus: 'PRICED' });
    const event = makeEvent({
      status: 'PARTIAL',
      lines: [{ itemId: ITEM_ID, dispensedQuantity: 3, lineStatus: 'PARTIAL' }],
    });
    const res = await handlePosWebhook(makeRequest(event), deps);

    assert.equal(res.status, 200);
    assert.deepEqual(seen.applied[0].lines, [{ itemId: ITEM_ID, dispensedQuantity: 3, lineStatus: 'PARTIAL' }]);
  });
});

describe('handlePosWebhook — payload validation', () => {
  test('rejects a validly-signed but structurally invalid payload with 422', async () => {
    const { deps, seen } = makeDeps();
    const res = await handlePosWebhook(makeRequest({ contractVersion: CONTRACT_VERSION }), deps);

    assert.equal(res.status, 422);
    assert.deepEqual(seen.applied, []);
  });

  test('rejects a mismatched contract version', async () => {
    const { deps } = makeDeps();
    const res = await handlePosWebhook(makeRequest(makeEvent({ contractVersion: '2.0.0' as '1.0.0' })), deps);
    assert.equal(res.status, 422);
  });

  test('rejects a status outside the agreed vocabulary', async () => {
    const { deps } = makeDeps();
    const res = await handlePosWebhook(makeRequest(makeEvent({ status: 'SHIPPED' as 'PRICED' })), deps);
    assert.equal(res.status, 422);
  });

  test('rejects signed but non-JSON bytes with 422, not a crash', async () => {
    const { deps } = makeDeps();
    const res = await handlePosWebhook(makeRequest(null, { rawBodyOverride: 'not json at all' }), deps);
    assert.equal(res.status, 422);
  });
});
