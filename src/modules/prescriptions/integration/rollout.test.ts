/**
 * Deploying the clinic before the till.
 *
 * The counterpart of vitcare-pos/src/lib/integration/rollout.test.ts, which
 * pins the other direction. Together they say: every combination of old and
 * new on the two sides is SAFE — the version interlock makes those states
 * survivable rather than refusing them, which is easy to state backwards and
 * so is pinned here rather than in a pull request nobody reads after it merges.
 *
 * The case this file is about: a new clinic, a till that has not been updated.
 * A settled prescription tells the till not to collect. A till that cannot read
 * the instruction must never be handed the prescription — it would dispense the
 * medicine and take the patient's money while the farm was billed for the same
 * drugs on its statement. One dispensing, two bills, and nothing looking wrong
 * on either document.
 *
 * Withholding it is not "losing" it: the row stays in the outbox, keeps being
 * offered, and shows up in pharmacy_link_health()'s oldest_undelivered_at.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { negotiatedVersion, versionsUpTo } from './pull-handler';
import {
  BASELINE_CONTRACT_VERSION,
  CONTRACT_VERSION,
  versionFor,
} from './prescription-contract';

/** What a till of a given vintage sends, and therefore is served. */
function servedTo(till: 'old' | 'new'): string[] {
  const headers = new Headers();
  // A till built before negotiation existed sends no header at all. That
  // silence is the case the whole guarantee rests on.
  if (till === 'new') headers.set('X-Contract-Version', CONTRACT_VERSION);
  return versionsUpTo(negotiatedVersion(headers));
}

/** Whether a prescription of a given kind reaches that till. */
function reaches(till: 'old' | 'new', kind: 'ordinary' | 'settled'): boolean {
  const stamp = versionFor(kind === 'settled' ? { settlement: {} } : {});
  return servedTo(till).includes(stamp);
}

describe('new clinic, old till', () => {
  test('an ordinary prescription still reaches the pharmacy', () => {
    // The 99% path. If this ever went false the pharmacy would go quiet for
    // every patient in the facility, with nothing failing anywhere.
    assert.equal(reaches('old', 'ordinary'), true);
  });

  test('a settled prescription does NOT', () => {
    assert.equal(reaches('old', 'settled'), false);
  });
});

describe('new clinic, new till', () => {
  test('both reach it', () => {
    assert.equal(reaches('new', 'ordinary'), true);
    assert.equal(reaches('new', 'settled'), true);
  });
});

describe('the guarantee stated once, over every combination', () => {
  test('no till is ever served a prescription it cannot honour', () => {
    for (const till of ['old', 'new'] as const) {
      const served = servedTo(till);
      for (const stamp of served) {
        assert.ok(
          // A till is served a version only if it declared it can honour it —
          // or, for a silent old till, only the baseline it was built against.
          till === 'new' || stamp === BASELINE_CONTRACT_VERSION,
          `${till} till was served ${stamp}`,
        );
      }
    }
  });

  test('every till is served the baseline, so ordinary work never stops', () => {
    for (const till of ['old', 'new'] as const) {
      assert.ok(servedTo(till).includes(BASELINE_CONTRACT_VERSION), `${till} till`);
    }
  });
});

describe('a row whose version cannot be read', () => {
  test('is served to nobody rather than to the oldest caller', () => {
    // `payload->>contractVersion` is NULL for a malformed row, and an IN filter
    // excludes NULL — so such a row is withheld from every till. That is the
    // safe direction: a version we cannot interpret is not evidence that a
    // baseline till can handle it. It stays queued and ages visibly in
    // pharmacy_link_health() rather than being handed to a till on a guess.
    for (const till of ['old', 'new'] as const) {
      assert.equal(servedTo(till).includes('' as unknown as string), false, `${till} till`);
    }
  });
});
