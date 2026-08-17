/**
 * Tests for the clinic's boot-time configuration contract.
 *
 * The case that matters most is the last block: the Vercel deployment holds
 * no secrets by design, so a schema that demanded them would refuse to start
 * a supported deployment.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerEnv, EnvironmentError, type RawEnv } from './env';

const MINIMAL = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_example',
} satisfies RawEnv;

const POS_FULL = {
  POS_BASE_URL: 'https://till.local/api',
  POS_SIGNING_SECRET: 'a'.repeat(32),
  OUTBOX_DRAIN_SECRET: 'drain-secret',
};

function problemsFor(env: RawEnv): string[] {
  try { parseServerEnv(env); return []; } catch (e) {
    assert.ok(e instanceof EnvironmentError, 'expected EnvironmentError');
    return e.problems;
  }
}

const mentions = (problems: string[], key: string) => problems.some((p) => p.startsWith(`${key}:`));

function omit<T extends Record<string, string | undefined>>(obj: T, ...keys: string[]): RawEnv {
  const copy: RawEnv = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

describe('required configuration', () => {
  test('the minimum boots', () => {
    assert.deepEqual(problemsFor(MINIMAL), []);
  });

  test('a missing Supabase URL is fatal', () => {
    assert.ok(mentions(problemsFor(omit(MINIMAL, 'NEXT_PUBLIC_SUPABASE_URL')), 'NEXT_PUBLIC_SUPABASE_URL'));
  });

  test('a missing anon key is fatal', () => {
    assert.ok(mentions(problemsFor(omit(MINIMAL, 'NEXT_PUBLIC_SUPABASE_ANON_KEY')), 'NEXT_PUBLIC_SUPABASE_ANON_KEY'));
  });
});

describe('POS integration is all-or-nothing', () => {
  test('none configured is fine', () => {
    assert.deepEqual(problemsFor(MINIMAL), []);
  });

  test('all configured is fine', () => {
    assert.deepEqual(problemsFor({ ...MINIMAL, ...POS_FULL }), []);
  });

  test('half configured is fatal — prescriptions would be signed and never delivered', () => {
    const half = omit(POS_FULL, 'OUTBOX_DRAIN_SECRET');
    assert.ok(problemsFor({ ...MINIMAL, ...half }).length > 0);
  });

  test('a signing secret under 32 bytes is rejected', () => {
    assert.ok(mentions(problemsFor({ ...MINIMAL, ...POS_FULL, POS_SIGNING_SECRET: 'short' }), 'POS_SIGNING_SECRET'));
  });

  test('a non-numeric timeout is rejected', () => {
    assert.ok(mentions(problemsFor({ ...MINIMAL, POS_REQUEST_TIMEOUT_MS: 'soon' }), 'POS_REQUEST_TIMEOUT_MS'));
  });
});

describe('bundle safety', () => {
  test('a service_role key in a NEXT_PUBLIC_ variable is fatal', () => {
    assert.ok(problemsFor({ ...MINIMAL, NEXT_PUBLIC_X: 'a.service_role.b' }).some((p) => p.includes('service_role')));
  });
});

describe('the secretless Vercel deployment still boots', () => {
  test('URL + anon key alone is a valid, complete configuration', () => {
    // The cloud copy deliberately holds no secrets: its integration routes
    // fail closed and the Mac's drains do all machine-to-machine work. A
    // schema that required POS_SIGNING_SECRET would refuse to start it.
    assert.deepEqual(problemsFor(MINIMAL), []);
  });

  test('empty placeholder lines do not count as configuration', () => {
    assert.deepEqual(
      problemsFor({ ...MINIMAL, POS_BASE_URL: '', POS_SIGNING_SECRET: '', OUTBOX_DRAIN_SECRET: '' }),
      [],
    );
  });
});

describe('pull mode: POS_SIGNING_SECRET is complete on its own', () => {
  // REGRESSION. On 2026-08-17 the publicly hosted clinic was given
  // POS_SIGNING_SECRET alone — precisely what the pull endpoints need, since
  // the till calls us and there is nothing to dial out to. The old
  // all-or-nothing rule counted that as 1-of-3 and threw at boot, so every
  // route answered 502 for ~24 minutes. The only ways to satisfy the old rule
  // were to remove the secret (disabling pull) or to invent a POS_BASE_URL
  // pointing at a till the cloud host cannot reach.
  test('the signing secret alone is a valid configuration', () => {
    assert.deepEqual(problemsFor({ ...MINIMAL, POS_SIGNING_SECRET: 'a'.repeat(32) }), []);
  });

  test('a weak signing secret is still rejected in pull mode', () => {
    // Relaxing the pairing must not relax the strength check — this secret
    // authenticates every inbound call from the till.
    assert.ok(mentions(problemsFor({ ...MINIMAL, POS_SIGNING_SECRET: 'short' }), 'POS_SIGNING_SECRET'));
  });
});

describe('push mode is still all-or-nothing', () => {
  test('the full trio remains valid', () => {
    assert.deepEqual(problemsFor({ ...MINIMAL, ...POS_FULL }), []);
  });

  test('a base URL without the drain secret is rejected', () => {
    const problems = problemsFor({
      ...MINIMAL,
      POS_BASE_URL: POS_FULL.POS_BASE_URL,
      POS_SIGNING_SECRET: POS_FULL.POS_SIGNING_SECRET,
    });
    assert.ok(mentions(problems, 'OUTBOX_DRAIN_SECRET'));
  });

  test('a drain secret without the base URL is rejected', () => {
    const problems = problemsFor({
      ...MINIMAL,
      OUTBOX_DRAIN_SECRET: POS_FULL.OUTBOX_DRAIN_SECRET,
      POS_SIGNING_SECRET: POS_FULL.POS_SIGNING_SECRET,
    });
    assert.ok(mentions(problems, 'POS_BASE_URL'));
  });

  test('push keys without a signing secret name the missing secret', () => {
    // The push path cannot sign anything without it, so this stays an error —
    // it is only unpaired in the pull direction.
    const problems = problemsFor({
      ...MINIMAL,
      POS_BASE_URL: POS_FULL.POS_BASE_URL,
      OUTBOX_DRAIN_SECRET: POS_FULL.OUTBOX_DRAIN_SECRET,
    });
    assert.ok(problems.some((p) => p.includes('POS_SIGNING_SECRET')));
  });
});
