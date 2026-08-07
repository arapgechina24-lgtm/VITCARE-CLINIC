/**
 * VITCARE-CLINIC — TS ↔ SQL state machine parity guard
 * ---------------------------------------------------------------------------
 * The prescription state machine is defined twice, on purpose: in TypeScript
 * (the webhook handler's pre-flight, so a bad transition gets a clean 409
 * without a write) and in SQL (0009_apply_status_event.sql, which re-checks it
 * under a row lock and is the authority).
 *
 * Duplication buys race-safety and costs drift risk. This test is how the cost
 * is paid: it parses the real migration file and asserts exact parity with
 * ALLOWED_TRANSITIONS. It needs no database, so it runs in the ordinary suite.
 *
 * Drift here would be the worst class of bug in this system — silent, and only
 * visible under concurrency, where the app and the database disagree about what
 * is legal. Do not delete this test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ALLOWED_TRANSITIONS, type PrescriptionStatus } from './prescription-contract';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(here, '../../../../supabase/migrations/0009_apply_status_event.sql');

/** The ('FROM','TO') pairs inside is_allowed_transition's VALUES block. */
function sqlTransitions(): Set<string> {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const start = sql.indexOf('from (values');
  const end = sql.indexOf(') as t(cur, nxt)');
  assert.ok(start > -1, 'VALUES block not found — did is_allowed_transition move?');
  assert.ok(end > start, 'VALUES block terminator not found');

  return new Set(
    [...sql.slice(start, end).matchAll(/\('([A-Z_]+)','([A-Z_]+)'\)/g)].map((m) => `${m[1]}->${m[2]}`),
  );
}

function tsTransitions(): Set<string> {
  return new Set(
    Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`)),
  );
}

describe('prescription state machine parity (TS ↔ SQL)', () => {
  test('the SQL file is actually found and parsed', () => {
    // Without this, a moved file would make every assertion below compare two
    // empty sets and pass — a guard that silently stops guarding.
    assert.ok(sqlTransitions().size > 0, 'parsed zero transitions from the SQL');
  });

  test('SQL allows every transition TypeScript allows', () => {
    const sql = sqlTransitions();
    const missing = [...tsTransitions()].filter((t) => !sql.has(t));
    assert.deepEqual(missing, [], `missing from SQL: ${missing.join(', ')}`);
  });

  test('SQL allows no transition TypeScript forbids', () => {
    const ts = tsTransitions();
    const extra = [...sqlTransitions()].filter((t) => !ts.has(t));
    assert.deepEqual(extra, [], `in SQL but not TS: ${extra.join(', ')}`);
  });

  test('terminal states stay terminal on both sides', () => {
    const sql = sqlTransitions();
    for (const terminal of ['COLLECTED', 'CANCELLED'] as const satisfies readonly PrescriptionStatus[]) {
      assert.deepEqual(ALLOWED_TRANSITIONS[terminal], [], `${terminal} has outgoing transitions in TS`);
      assert.deepEqual(
        [...sql].filter((t) => t.startsWith(`${terminal}->`)),
        [],
        `${terminal} has outgoing transitions in SQL`,
      );
    }
  });

  test('every status in the contract is reachable or terminal', () => {
    // Catches a status added to the union but wired into neither table — it
    // would otherwise sit there looking supported and be permanently unusable.
    const sql = sqlTransitions();
    const mentioned = new Set([...sql].flatMap((t) => t.split('->')));
    for (const status of Object.keys(ALLOWED_TRANSITIONS)) {
      assert.ok(mentioned.has(status), `${status} appears nowhere in the SQL transition table`);
    }
  });
});
