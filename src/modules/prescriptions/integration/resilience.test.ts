/**
 * Resilience of the clinic → POS delivery path, against a real socket.
 *
 * The thing under test is NOT mocked: these tests stand up an actual HTTP
 * server on localhost and let PosClient talk to it, so the timeout, the abort,
 * and the status classification are the real ones.
 *
 * ── WHY THE CLASSIFICATION IS THE POINT ───────────────────────────────────
 * `permanent: true` means the outbox marks the row failed and STOPS RETRYING.
 * A prescription classified permanent by mistake is a prescription the
 * pharmacy never receives and the clinician believes was sent. Every
 * assertion below is really asking: would this failure lose a prescription?
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PosClient } from './pos-client-outbox';
import { CONTRACT_VERSION, type CreatePrescription } from './prescription-contract';

/** Same shape as pos-client-outbox.test.ts's fixture — a payload that passes
 *  client-side validation, so these tests exercise the NETWORK path rather
 *  than bouncing off the schema before a socket is ever opened. */
const PAYLOAD = {
  contractVersion: CONTRACT_VERSION,
  prescriptionId: '11111111-1111-4111-8111-111111111111',
  fulfillmentSiteId: '33333333-3333-4333-8333-333333333333',
  encounterId: '44444444-4444-4444-8444-444444444444',
  issuedAt: new Date().toISOString(),
  patient: { mrn: 'VC-RESILIENCE-01', fullName: 'Socket Probe', payer: 'CASH' },
  prescriber: { userId: '55555555-5555-4555-8555-555555555555', name: 'Dr. Probe' },
  items: [{
    itemId: '66666666-6666-4666-8666-666666666666',
    drugName: 'Probe', dose: '1 capsule', frequency: 'OD', quantity: 1,
    substitutionAllowed: false,
  }],
} as CreatePrescription;

/** Behaviour the fake POS should exhibit for the next request. */
let mode: 'ok' | 'slow' | 'hang' | 'truncate' | number = 'ok';
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    if (typeof mode === 'number') {
      res.writeHead(mode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'x' }));
      return;
    }
    if (mode === 'hang') return; // never respond, never close
    if (mode === 'slow') {
      setTimeout(() => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 150);
      return;
    }
    if (mode === 'truncate') {
      // Valid status, then a body that stops mid-JSON and a socket that dies.
      res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': '999' });
      res.write('{"ok":tr');
      res.destroy();
      return;
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, duplicate: false }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); });

const client = (timeoutMs = 1000) =>
  new PosClient({ baseUrl: base, signingSecret: 'a'.repeat(32), timeoutMs });

describe('dependency is healthy', () => {
  test('a 202 is a success', async () => {
    mode = 'ok';
    const r = await client().sendPrescription(PAYLOAD);
    assert.equal(r.ok, true);
    assert.equal(r.status, 202);
  });

  test('slow but inside the timeout still succeeds', async () => {
    mode = 'slow';
    const r = await client(1000).sendPrescription(PAYLOAD);
    assert.equal(r.ok, true, 'a 150ms response must not be treated as a failure');
  });
});

describe('dependency is unreachable or too slow', () => {
  test('a hanging dependency aborts at the timeout and is TRANSIENT', async () => {
    mode = 'hang';
    const started = Date.now();
    const r = await client(200).sendPrescription(PAYLOAD);
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.permanent, false, 'a timeout must be retried, never discarded');
    assert.equal(r.status, 0);
    assert.ok(elapsed < 2000, `aborted in ${elapsed}ms — the timeout must actually fire`);
  });

  test('a dependency that is DOWN is TRANSIENT, not permanent', async () => {
    // Port 1 is reserved and nothing listens there: connection refused.
    const r = await new PosClient({
      baseUrl: 'http://127.0.0.1:1/api', signingSecret: 'a'.repeat(32), timeoutMs: 1000,
    }).sendPrescription(PAYLOAD);
    assert.equal(r.ok, false);
    assert.equal(r.permanent, false, 'the pharmacy being offline must not discard a prescription');
  });

  test('a truncated response body does not mark the delivery permanent', async () => {
    mode = 'truncate';
    const r = await client(1000).sendPrescription(PAYLOAD);
    // Either it read the 202 before the socket died (ok), or the read failed
    // (transient). What it must NEVER be is permanent.
    assert.notEqual(r.permanent, true, 'a half-read response must not discard a prescription');
  });
});

describe('status classification decides whether a prescription survives', () => {
  const transient = [408, 429, 500, 502, 503, 504];
  const permanent = [400, 401, 403, 404, 409, 413, 422];

  for (const s of transient) {
    test(`${s} is transient — the outbox will retry`, async () => {
      mode = s;
      const r = await client().sendPrescription(PAYLOAD);
      assert.equal(r.ok, false);
      assert.equal(r.permanent, false, `${s} must be retried`);
    });
  }

  for (const s of permanent) {
    test(`${s} is permanent — retrying cannot help`, async () => {
      mode = s;
      const r = await client().sendPrescription(PAYLOAD);
      assert.equal(r.ok, false);
      assert.equal(r.permanent, true, `${s} must not be retried forever`);
    });
  }
});

describe('client-side rejection', () => {
  test('an invalid payload is permanent and never reaches the network', async () => {
    mode = 500; // would be transient if it got that far
    const r = await client().sendPrescription({ nonsense: true } as unknown as CreatePrescription);
    assert.equal(r.permanent, true);
    assert.equal(r.status, 0, 'must fail before any request is made');
  });
});
