/**
 * Tests for drain endpoint authentication.
 *
 * This is the only credential that lets an unauthenticated caller drive the
 * integration, so the important cases are the ones where it must say no.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readDrainToken, drainTokenValid, authorizeDrain } from './drain-auth';

const SECRET = 'a-drain-secret-of-reasonable-length';

const h = (init: Record<string, string>) => new Headers(init);

describe('readDrainToken', () => {
  test('reads a Bearer token', () => {
    assert.equal(readDrainToken(h({ authorization: `Bearer ${SECRET}` })), SECRET);
  });

  test('accepts the scheme case-insensitively, as RFC 7235 requires', () => {
    assert.equal(readDrainToken(h({ authorization: `bearer ${SECRET}` })), SECRET);
  });

  test('tolerates extra whitespace around the token', () => {
    assert.equal(readDrainToken(h({ authorization: `Bearer   ${SECRET}  ` })), SECRET);
  });

  test('falls back to X-Drain-Token for schedulers that cannot set Authorization', () => {
    assert.equal(readDrainToken(h({ 'x-drain-token': SECRET })), SECRET);
  });

  test('prefers Authorization when both are present', () => {
    const got = readDrainToken(h({ authorization: `Bearer ${SECRET}`, 'x-drain-token': 'other' }));
    assert.equal(got, SECRET);
  });

  test('returns null when no credential is offered', () => {
    assert.equal(readDrainToken(h({})), null);
  });

  test('returns null for a non-Bearer scheme rather than reading it as a token', () => {
    assert.equal(readDrainToken(h({ authorization: `Basic ${SECRET}` })), null);
  });

  test('ignores a token in the query string — the whole point of the change', () => {
    // Nothing here ever looks at the URL. A caller still passing ?token= gets
    // rejected, which is the desired migration behaviour: fail loudly rather
    // than keep accepting the credential in a place that gets logged.
    assert.equal(readDrainToken(h({})), null);
  });
});

describe('drainTokenValid', () => {
  test('accepts the exact secret', () => {
    assert.equal(drainTokenValid(SECRET, SECRET), true);
  });

  test('rejects a wrong token of the same length', () => {
    const wrong = 'X'.repeat(SECRET.length);
    assert.equal(wrong.length, SECRET.length);
    assert.equal(drainTokenValid(wrong, SECRET), false);
  });

  test('rejects a correct prefix — no partial credit', () => {
    assert.equal(drainTokenValid(SECRET.slice(0, -1), SECRET), false);
  });

  test('rejects a longer token that starts with the secret', () => {
    assert.equal(drainTokenValid(`${SECRET}extra`, SECRET), false);
  });

  test('an unset secret closes the endpoint, it does not open it', () => {
    // A missing env var must never mean "no authentication required".
    assert.equal(drainTokenValid(SECRET, undefined), false);
    assert.equal(drainTokenValid(SECRET, ''), false);
  });

  test('a null presented token is rejected without throwing', () => {
    assert.equal(drainTokenValid(null, SECRET), false);
  });

  test('an empty presented token is rejected even against an empty secret', () => {
    assert.equal(drainTokenValid('', ''), false);
  });
});

describe('authorizeDrain', () => {
  test('accepts a correctly presented Bearer token', () => {
    assert.equal(authorizeDrain(h({ authorization: `Bearer ${SECRET}` }), SECRET), true);
  });

  test('rejects an unauthenticated request', () => {
    assert.equal(authorizeDrain(h({}), SECRET), false);
  });

  test('rejects everything when the secret is unconfigured', () => {
    assert.equal(authorizeDrain(h({ authorization: `Bearer ${SECRET}` }), undefined), false);
  });
});
