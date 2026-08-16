import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_START_MIN,
  DAY_END_MIN,
  buildLanes,
  canArrive,
  canCancel,
  canMarkNoShow,
  clinicDateKey,
  clinicDayRange,
  clinicInstant,
  dayStats,
  findConflict,
  formatMinutes,
  isBlocking,
  minutesInClinicDay,
  nextFreeSlot,
  overlaps,
  shiftDateKey,
  type AppointmentRow,
  type AppointmentStatus,
} from './appointments';

/** Nairobi is UTC+3, so 06:00Z is 09:00 at the clinic. Fixtures are written in
 *  UTC deliberately — that is what the database returns, and the whole point of
 *  the clinic-time helpers is that the UI never sees a UTC hour. */
const at = (utcHour: number, utcMin = 0) =>
  `2026-08-17T${String(utcHour).padStart(2, '0')}:${String(utcMin).padStart(2, '0')}:00Z`;

let seq = 0;
function appt(over: Partial<AppointmentRow> = {}): AppointmentRow {
  seq += 1;
  return {
    id: `a${seq}`,
    patient_id: `p${seq}`,
    patient_full_name: 'Test Patient',
    patient_mrn: 'VC-20260817-000001',
    patient_phone: null,
    clinician_id: 'c1',
    clinician_name: 'Dr. Test',
    starts_at: at(6),
    duration_min: 30,
    reason: null,
    status: 'SCHEDULED',
    encounter_id: null,
    ...over,
  };
}

describe('clinic time', () => {
  test('reads the Nairobi hour, not the host hour', () => {
    // 06:00Z is 09:00 in Nairobi. If this ever returns 360 the module has
    // fallen back to UTC and every timeline block is three hours out.
    assert.equal(minutesInClinicDay(at(6)), 9 * 60);
    assert.equal(minutesInClinicDay(at(13, 30)), 16 * 60 + 30);
  });

  test('midnight normalises to 0, not 1440', () => {
    // 21:00Z is 00:00 the next day in Nairobi — the hour12:false / hour-24 trap.
    assert.equal(minutesInClinicDay('2026-08-16T21:00:00Z'), 0);
  });

  test('the calendar date rolls at clinic midnight, not UTC midnight', () => {
    // 22:00Z on the 16th is already 01:00 on the 17th at the clinic.
    assert.equal(clinicDateKey('2026-08-16T22:00:00Z'), '2026-08-17');
    assert.equal(clinicDateKey('2026-08-16T20:00:00Z'), '2026-08-16');
  });

  test('a day range covers exactly 24h and starts at clinic midnight', () => {
    const { from, to } = clinicDayRange('2026-08-17');
    assert.equal(from.toISOString(), '2026-08-16T21:00:00.000Z');
    assert.equal(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000);
    // The boundary instants must classify into the right clinic day, or the
    // day view silently drops its first and last appointments.
    assert.equal(clinicDateKey(from.toISOString()), '2026-08-17');
    assert.equal(clinicDateKey(new Date(to.getTime() - 1).toISOString()), '2026-08-17');
  });

  test('clinicInstant round-trips against minutesInClinicDay', () => {
    // The booking form's output must land back on the minute the timeline drew.
    for (const min of [DAY_START_MIN, 9 * 60 + 30, 12 * 60, DAY_END_MIN - 15]) {
      const iso = clinicInstant('2026-08-17', min).toISOString();
      assert.equal(minutesInClinicDay(iso), min, `round-trip failed at ${min}`);
      assert.equal(clinicDateKey(iso), '2026-08-17');
    }
  });

  test('a 9am clinic booking is 06:00Z, not 09:00Z', () => {
    // The specific bug this module exists to avoid: composing the instant from
    // the server's own locale would store 09:00Z and display 12:00 in Nairobi.
    assert.equal(clinicInstant('2026-08-17', 9 * 60).toISOString(), '2026-08-17T06:00:00.000Z');
  });

  test('date keys shift across month and year ends', () => {
    assert.equal(shiftDateKey('2026-08-31', 1), '2026-09-01');
    assert.equal(shiftDateKey('2026-01-01', -1), '2025-12-31');
    assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28');
  });

  test('formats minutes as a clinic clock', () => {
    assert.equal(formatMinutes(8 * 60), '8:00am');
    assert.equal(formatMinutes(12 * 60), '12:00pm');
    assert.equal(formatMinutes(13 * 60 + 45), '1:45pm');
    assert.equal(formatMinutes(0), '12:00am');
  });
});

describe('overlap — must match the exclusion constraint', () => {
  test('back-to-back slots do not clash', () => {
    // Upper bound is exclusive in tstzrange. If this flips, every clinic that
    // books 9:00 then 9:30 gets a spurious rejection.
    assert.equal(
      overlaps({ startMin: 540, durationMin: 30 }, { startMin: 570, durationMin: 30 }),
      false,
    );
  });

  test('any real intersection clashes, in both orders', () => {
    const a = { startMin: 540, durationMin: 30 };
    const b = { startMin: 555, durationMin: 30 };
    assert.equal(overlaps(a, b), true);
    assert.equal(overlaps(b, a), true);
  });

  test('containment clashes', () => {
    assert.equal(
      overlaps({ startMin: 540, durationMin: 120 }, { startMin: 570, durationMin: 15 }),
      true,
    );
  });
});

describe('findConflict', () => {
  test('finds a clash with the same clinician', () => {
    const existing = [appt({ starts_at: at(6), duration_min: 30 })];
    const hit = findConflict(existing, { clinicianId: 'c1', startMin: 9 * 60 + 15, durationMin: 30 });
    assert.equal(hit?.id, existing[0].id);
  });

  test('ignores a different clinician', () => {
    const existing = [appt({ clinician_id: 'c2' })];
    assert.equal(findConflict(existing, { clinicianId: 'c1', startMin: 9 * 60, durationMin: 30 }), null);
  });

  test('ignores non-blocking statuses so a cancelled slot is re-bookable', () => {
    for (const status of ['CANCELLED', 'NO_SHOW', 'COMPLETED'] as AppointmentStatus[]) {
      const existing = [appt({ status })];
      assert.equal(
        findConflict(existing, { clinicianId: 'c1', startMin: 9 * 60, durationMin: 30 }),
        null,
        `${status} should not block`,
      );
    }
  });

  test('an unassigned candidate never clashes', () => {
    const existing = [appt()];
    assert.equal(findConflict(existing, { clinicianId: null, startMin: 9 * 60, durationMin: 30 }), null);
  });

  test('ignoreId lets an appointment be rescheduled onto itself', () => {
    const existing = [appt({ id: 'keep' })];
    const hit = findConflict(existing, {
      clinicianId: 'c1', startMin: 9 * 60, durationMin: 30, ignoreId: 'keep',
    });
    assert.equal(hit, null);
  });
});

describe('nextFreeSlot', () => {
  test('returns the start of the day when nothing is booked', () => {
    assert.equal(nextFreeSlot([], 'c1', 30), DAY_START_MIN);
  });

  test('skips past a booked block to the next free grid slot', () => {
    // 9:00–10:00 booked → first 30-min slot on the 15-min grid is 10:00.
    const existing = [appt({ starts_at: at(6), duration_min: 60 })];
    assert.equal(nextFreeSlot(existing, 'c1', 30, DAY_START_MIN), DAY_START_MIN);
    assert.equal(nextFreeSlot(existing, 'c1', 30, 9 * 60), 10 * 60);
  });

  test('will not return a slot that runs past the end of the clinic day', () => {
    // A 60-minute appointment cannot start at 16:30 when the day ends at 17:00.
    assert.equal(nextFreeSlot([], 'c1', 60, DAY_END_MIN - 30), null);
  });

  test('returns null when the day is genuinely full', () => {
    const full = [appt({ starts_at: at(5), duration_min: DAY_END_MIN - DAY_START_MIN })];
    assert.equal(nextFreeSlot(full, 'c1', 30), null);
  });

  test('never proposes a slot that findConflict then rejects', () => {
    const existing = [
      appt({ starts_at: at(6), duration_min: 45 }),
      appt({ starts_at: at(8), duration_min: 30 }),
      appt({ starts_at: at(9, 30), duration_min: 60 }),
    ];
    const slot = nextFreeSlot(existing, 'c1', 30, 9 * 60);
    assert.notEqual(slot, null);
    assert.equal(findConflict(existing, { clinicianId: 'c1', startMin: slot!, durationMin: 30 }), null);
  });
});

describe('status guards mirror the RPCs', () => {
  test('arrival is refused for closed appointments only', () => {
    assert.equal(canArrive({ status: 'SCHEDULED' }), true);
    assert.equal(canArrive({ status: 'ARRIVED' }), true); // idempotent re-press
    assert.equal(canArrive({ status: 'CANCELLED' }), false);
    assert.equal(canArrive({ status: 'NO_SHOW' }), false);
  });

  test('a completed or cancelled appointment cannot be cancelled again', () => {
    assert.equal(canCancel({ status: 'SCHEDULED' }), true);
    assert.equal(canCancel({ status: 'COMPLETED' }), false);
    assert.equal(canCancel({ status: 'CANCELLED' }), false);
  });

  test('no-show only applies to someone who never arrived', () => {
    assert.equal(canMarkNoShow({ status: 'SCHEDULED' }), true);
    assert.equal(canMarkNoShow({ status: 'CONFIRMED' }), true);
    assert.equal(canMarkNoShow({ status: 'ARRIVED' }), false);
    assert.equal(canMarkNoShow({ status: 'COMPLETED' }), false);
  });

  test('blocking set matches the constraint WHERE clause', () => {
    assert.deepEqual(
      (['SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as AppointmentStatus[])
        .filter(isBlocking),
      ['SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS'],
    );
  });
});

describe('buildLanes', () => {
  const clinicians = [
    { id: 'c1', full_name: 'Dr. One', role: 'CLINICIAN' },
    { id: 'c2', full_name: 'Dr. Two', role: 'CLINICIAN' },
  ];

  test('gives every clinician a lane, including empty ones', () => {
    const lanes = buildLanes([appt({ clinician_id: 'c1' })], clinicians);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[1].appointments.length, 0);
  });

  test('surfaces unassigned appointments in their own lane', () => {
    const lanes = buildLanes([appt({ clinician_id: null })], clinicians);
    assert.equal(lanes.length, 3);
    assert.equal(lanes[2].clinicianId, null);
    assert.equal(lanes[2].appointments.length, 1);
  });

  test('omits the unassigned lane when nothing is unassigned', () => {
    assert.equal(buildLanes([appt()], clinicians).length, 2);
  });

  test('cancelled and no-show leave no block on the timeline', () => {
    const lanes = buildLanes(
      [appt({ status: 'CANCELLED' }), appt({ status: 'NO_SHOW' }), appt({ status: 'COMPLETED' })],
      clinicians,
    );
    // Completed time was genuinely consumed, so it stays; the other two did not.
    assert.equal(lanes[0].appointments.length, 1);
    assert.equal(lanes[0].appointments[0].status, 'COMPLETED');
  });

  test('an appointment for an unknown clinician is not dropped', () => {
    // A clinician who left the site still has yesterday's bookings. Silently
    // discarding them would understate the day.
    const lanes = buildLanes([appt({ clinician_id: 'gone' })], clinicians);
    assert.equal(lanes.at(-1)!.clinicianId, null);
    assert.equal(lanes.at(-1)!.appointments.length, 1);
  });
});

describe('dayStats', () => {
  test('counts each state and does not double-count', () => {
    const s = dayStats(
      [
        appt({ status: 'SCHEDULED' }),
        appt({ status: 'ARRIVED' }),
        appt({ status: 'IN_PROGRESS' }),
        appt({ status: 'COMPLETED' }),
        appt({ status: 'NO_SHOW' }),
        appt({ status: 'CANCELLED' }),
      ],
      2,
    );
    assert.equal(s.total, 6);
    assert.equal(s.arrived, 2); // ARRIVED + IN_PROGRESS
    assert.equal(s.completed, 1);
    assert.equal(s.noShow, 1);
    assert.equal(s.cancelled, 1);
  });

  test('utilisation ignores cancelled time and is capped at 1', () => {
    const capacity = DAY_END_MIN - DAY_START_MIN; // one clinician, 540 min
    const half = dayStats([appt({ duration_min: capacity / 2 })], 1);
    assert.equal(half.utilisation, 0.5);

    const withCancelled = dayStats(
      [appt({ duration_min: capacity / 2 }), appt({ duration_min: capacity, status: 'CANCELLED' })],
      1,
    );
    assert.equal(withCancelled.utilisation, 0.5);

    const over = dayStats([appt({ duration_min: capacity }), appt({ duration_min: capacity })], 1);
    assert.equal(over.utilisation, 1);
  });

  test('no clinicians means no capacity rather than a divide-by-zero', () => {
    assert.equal(dayStats([appt()], 0).utilisation, 0);
  });

  test('counts unassigned bookings that still need a clinician', () => {
    const s = dayStats([appt({ clinician_id: null }), appt({ clinician_id: null, status: 'CANCELLED' })], 1);
    assert.equal(s.unassigned, 1);
  });
});
