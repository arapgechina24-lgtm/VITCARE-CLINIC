/**
 * Tests for the Supabase wiring of WebhookDeps.
 *
 * The focus is the apply path, because that is where the three defects fixed by
 * 0009_apply_status_event.sql lived. What matters is that this layer sends the
 * whole event to the database in ONE call and translates Postgres error codes
 * into errors the route can map — a lost race must not surface as a 500 that
 * POS retries against a permanently illegal transition.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  makeWebhookDeps,
  makeOutboxStore,
  StatusConflictError,
  PrescriptionNotFoundError,
  PG_ILLEGAL_TRANSITION,
  PG_PRESCRIPTION_NOT_FOUND,
} from './supabase-deps';
import type { PrescriptionStatusEvent } from './prescription-contract';

const EVENT: PrescriptionStatusEvent = {
  contractVersion: '1.0.0',
  eventId: '11111111-1111-4111-8111-111111111111',
  prescriptionId: '22222222-2222-4222-8222-222222222222',
  status: 'DISPENSED',
  occurredAt: '2026-08-07T09:00:00.000Z',
  totalAmountCents: 42000,
  lines: [
    {
      itemId: '33333333-3333-4333-8333-333333333333',
      dispensedQuantity: 21,
      lineStatus: 'OK',
    },
  ],
};

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

/** Records rpc() calls and returns a scripted error. */
function stubClient(error: { message: string; code?: string } | null) {
  const calls: RpcCall[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: null, error });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('makeWebhookDeps.applyStatusEvent', () => {
  test('sends the whole event in a single rpc call', async () => {
    // One call is the point: the previous implementation made four separate
    // round-trips with no transaction between them.
    const { client, calls } = stubClient(null);
    await makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'apply_status_event');
  });

  test('maps every contract field onto the function parameters', async () => {
    const { client, calls } = stubClient(null);
    await makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT);

    assert.deepEqual(calls[0].args, {
      p_event_id: EVENT.eventId,
      p_prescription_id: EVENT.prescriptionId,
      p_status: 'DISPENSED',
      p_total_amount_cents: 42000,
      p_reason: null,
      p_lines: EVENT.lines,
      p_scheme_settled: null,
    });
  });

  test('passes the prescription id alongside the lines', async () => {
    // This is what lets the SQL scope the per-item update by prescription_id.
    // Without it an itemId from another patient's prescription would be
    // writable by anyone holding the signing secret.
    const { client, calls } = stubClient(null);
    await makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT);

    assert.equal(calls[0].args.p_prescription_id, EVENT.prescriptionId);
    assert.ok(calls[0].args.p_lines, 'lines must reach the database');
  });

  test('sends null, not undefined, for absent optional fields', async () => {
    // Supabase drops undefined from the JSON body, which would leave the
    // function's parameters unbound rather than explicitly null.
    const { client, calls } = stubClient(null);
    const minimal: PrescriptionStatusEvent = {
      contractVersion: '1.0.0',
      eventId: EVENT.eventId,
      prescriptionId: EVENT.prescriptionId,
      status: 'CANCELLED',
      occurredAt: EVENT.occurredAt,
    };
    await makeWebhookDeps(client, 'secret').applyStatusEvent(minimal);

    assert.equal(calls[0].args.p_total_amount_cents, null);
    assert.equal(calls[0].args.p_reason, null);
    assert.equal(calls[0].args.p_lines, null);
  });

  test('P0001 becomes StatusConflictError, so the route can answer 409', async () => {
    const { client } = stubClient({ message: 'ILLEGAL_TRANSITION:DISPENSED->PRICED', code: PG_ILLEGAL_TRANSITION });
    await assert.rejects(
      () => makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT),
      StatusConflictError,
    );
  });

  test('P0002 becomes PrescriptionNotFoundError, so the route can answer 404', async () => {
    const { client } = stubClient({ message: 'PRESCRIPTION_NOT_FOUND', code: PG_PRESCRIPTION_NOT_FOUND });
    await assert.rejects(
      () => makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT),
      PrescriptionNotFoundError,
    );
  });

  test('any other database error propagates unchanged, so the route answers 500', async () => {
    // A connection failure is transient and POS SHOULD retry it. Mapping it to
    // 409 or 404 would tell POS to give up on a prescription that is fine.
    const { client } = stubClient({ message: 'connection reset', code: '08006' });
    await assert.rejects(
      () => makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT),
      (err: unknown) => {
        assert.ok(!(err instanceof StatusConflictError));
        assert.ok(!(err instanceof PrescriptionNotFoundError));
        return true;
      },
    );
  });

  test('an error with no code is not mistaken for a conflict', async () => {
    const { client } = stubClient({ message: 'something went wrong' });
    await assert.rejects(
      () => makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT),
      (err: unknown) => !(err instanceof StatusConflictError) && !(err instanceof PrescriptionNotFoundError),
    );
  });
});


/**
 * Records the filters applied to a query. The chainable methods return `this`
 * so the builder can be driven exactly as the real one is, and `then` makes it
 * awaitable at the end of the chain.
 */
function stubQuery() {
  const filters: Array<{ op: string; column: string; value: unknown }> = [];
  const builder = {
    filters,
    from() { return builder; },
    select() { return builder; },
    eq(column: string, value: unknown) { filters.push({ op: 'eq', column, value }); return builder; },
    lte(column: string, value: unknown) { filters.push({ op: 'lte', column, value }); return builder; },
    in(column: string, value: unknown) { filters.push({ op: 'in', column, value }); return builder; },
    order() { return builder; },
    limit() { return builder; },
    then(resolve: (r: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve(resolve({ data: [], error: null }));
    },
  };
  return builder;
}

describe('claimBatch — version filtering', () => {
  test('no version list leaves the query unfiltered, so the push path is unchanged', async () => {
    const q = stubQuery();
    await makeOutboxStore(q as unknown as SupabaseClient).claimBatch(25);
    assert.equal(q.filters.filter((f) => f.op === 'in').length, 0);
  });

  test('a version list is pushed into the QUERY, not applied to the page', async () => {
    // The distinction that matters. Filtering the returned page would let a
    // run of newer prescriptions at the head of the queue fill every page an
    // older till asks for — it would receive an empty list forever while
    // ordinary prescriptions waited behind them, with nothing failing.
    const q = stubQuery();
    await makeOutboxStore(q as unknown as SupabaseClient).claimBatch(25, ['1.0.0']);
    const applied = q.filters.find((f) => f.op === 'in');
    assert.ok(applied, 'the version list must reach the query');
    assert.equal(applied.column, 'payload->>contractVersion');
    assert.deepEqual(applied.value, ['1.0.0']);
  });

  test('eligibility is still decided by the database clock, not this process', async () => {
    // Guards the reason claimBatch is shared at all: the version filter must
    // narrow eligibility, never replace it.
    const q = stubQuery();
    await makeOutboxStore(q as unknown as SupabaseClient).claimBatch(25, ['1.0.0']);
    assert.deepEqual(
      q.filters.find((f) => f.op === 'lte'),
      { op: 'lte', column: 'next_attempt_at', value: 'now' },
    );
    assert.ok(q.filters.some((f) => f.op === 'eq' && f.column === 'delivered' && f.value === false));
    assert.ok(q.filters.some((f) => f.op === 'eq' && f.column === 'failed' && f.value === false));
  });
});


describe('applyStatusEvent — the scheme settlement report', () => {
  const SETTLED = {
    amountCents: 116000,
    invoiceNo: 'INV-42',
    memberId: '44444444-4444-4444-8444-444444444444',
  };

  test('an ordinary dispensing sends null, not an empty object', async () => {
    // Null is what the RPC's default and its `is not null` guard are written
    // against. An empty object would pass that guard and try to record a
    // dispensing with no membership behind it.
    const { client, calls } = stubClient(null);
    await makeWebhookDeps(client, 'secret').applyStatusEvent(EVENT);
    assert.equal(calls[0].args.p_scheme_settled, null);
  });

  test('a settled dispensing passes the report through whole', async () => {
    const { client, calls } = stubClient(null);
    await makeWebhookDeps(client, 'secret').applyStatusEvent({
      ...EVENT,
      contractVersion: '1.1.0',
      totalAmountCents: 0,
      schemeSettled: SETTLED,
    });
    assert.deepEqual(calls[0].args.p_scheme_settled, SETTLED);
  });

  test('it rides the SAME rpc call as the status change', async () => {
    // One call, one transaction. If the settlement were a second call, a
    // DISPENSED could commit while the farm's charge did not — a medicine
    // handed over for free with nothing left to invoice, and a webhook that
    // never retries because it succeeded.
    const { client, calls } = stubClient(null);
    await makeWebhookDeps(client, 'secret').applyStatusEvent({
      ...EVENT,
      contractVersion: '1.1.0',
      schemeSettled: SETTLED,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'apply_status_event');
  });
});
