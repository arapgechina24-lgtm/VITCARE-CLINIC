/**
 * Tests for the rate limiter.
 *
 * The clock is injected throughout — a limiter whose window behaviour is only
 * testable by sleeping is a limiter whose window behaviour does not get tested.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, resetRateLimits, clientKey } from './rate-limit';

const T0 = 1_800_000_000_000;
const WINDOW = 60_000;

beforeEach(() => resetRateLimits());

describe('rateLimit', () => {
  test('allows up to the limit', () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(rateLimit('k', 5, WINDOW, T0).ok, true, `request ${i + 1} should pass`);
    }
  });

  test('rejects the request after the limit', () => {
    for (let i = 0; i < 5; i += 1) rateLimit('k', 5, WINDOW, T0);
    assert.equal(rateLimit('k', 5, WINDOW, T0).ok, false);
  });

  test('counts down remaining, and never below zero', () => {
    assert.equal(rateLimit('k', 3, WINDOW, T0).remaining, 2);
    assert.equal(rateLimit('k', 3, WINDOW, T0).remaining, 1);
    assert.equal(rateLimit('k', 3, WINDOW, T0).remaining, 0);
    assert.equal(rateLimit('k', 3, WINDOW, T0).remaining, 0);
  });

  test('keys are independent — one actor cannot exhaust another', () => {
    for (let i = 0; i < 5; i += 1) rateLimit('alice', 5, WINDOW, T0);
    assert.equal(rateLimit('alice', 5, WINDOW, T0).ok, false);
    assert.equal(rateLimit('bob', 5, WINDOW, T0).ok, true);
  });

  test('the window reopens once it has elapsed', () => {
    for (let i = 0; i < 5; i += 1) rateLimit('k', 5, WINDOW, T0);
    assert.equal(rateLimit('k', 5, WINDOW, T0 + WINDOW - 1).ok, false, 'still inside the window');
    assert.equal(rateLimit('k', 5, WINDOW, T0 + WINDOW).ok, true, 'window has rolled over');
  });

  test('resetAt is stable across a window and does not slide', () => {
    // A fixed window, not a sliding one. If resetAt moved on every hit, a
    // steady stream of requests would extend the block indefinitely.
    const first = rateLimit('k', 5, WINDOW, T0).resetAt;
    const later = rateLimit('k', 5, WINDOW, T0 + 30_000).resetAt;
    assert.equal(first, T0 + WINDOW);
    assert.equal(later, first);
  });

  test('retryAfter is zero while allowed and positive once blocked', () => {
    assert.equal(rateLimit('k', 1, WINDOW, T0).retryAfter, 0);
    const blocked = rateLimit('k', 1, WINDOW, T0 + 10_000);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.retryAfter, 50);
  });

  test('retryAfter rounds up, so it never advises retrying too early', () => {
    rateLimit('k', 1, WINDOW, T0);
    // 500ms left — advising 0 would send the caller straight back into a 429.
    assert.equal(rateLimit('k', 1, WINDOW, T0 + WINDOW - 500).retryAfter, 1);
  });

  test('a limit of zero blocks the very first request', () => {
    assert.equal(rateLimit('k', 0, WINDOW, T0).ok, false);
  });

  test('survives being called far in the future without leaking state', () => {
    rateLimit('k', 5, WINDOW, T0);
    const fresh = rateLimit('k', 5, WINDOW, T0 + WINDOW * 1000);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.remaining, 4);
  });
});

describe('clientKey', () => {
  test('takes the first hop of x-forwarded-for', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' });
    assert.equal(clientKey(h), '203.0.113.5');
  });

  test('trims whitespace', () => {
    assert.equal(clientKey(new Headers({ 'x-forwarded-for': '  203.0.113.5  ' })), '203.0.113.5');
  });

  test('falls back to x-real-ip', () => {
    assert.equal(clientKey(new Headers({ 'x-real-ip': '203.0.113.9' })), '203.0.113.9');
  });

  test('prefers x-forwarded-for when both are present', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '203.0.113.9' });
    assert.equal(clientKey(h), '203.0.113.5');
  });

  test('returns a stable label when nothing identifies the caller', () => {
    // Everyone unidentifiable shares one bucket. That is the conservative
    // choice: it over-limits rather than granting an unlimited allowance to
    // anyone who strips the headers.
    assert.equal(clientKey(new Headers()), 'unknown');
  });
});
