/**
 * TS ↔ SQL parity for the role model.
 *
 * The matrix is written twice: in 0013_role_projected_reads.sql, which decides
 * what data is actually returned, and in roles.ts, which decides what the UI
 * bothers to render. That duplication is deliberate — the database must not
 * depend on the client to be safe — but duplication without a guard becomes
 * drift, and drift here means a screen that promises a receptionist something
 * the server will not give them, or worse, a UI that renders a tab for data it
 * assumes was withheld.
 *
 * Same reasoning as state-machine-parity.test.ts. Reads the real migration; no
 * database required. Keep it in CI.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ROLES, CAN, scopeFor, roleLabel } from './roles';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(resolve(here, '../../supabase/migrations/0013_role_projected_reads.sql'), 'utf8');

/** The role list inside a `role in ('A','B')` clause of a named function. */
function sqlRolesFor(fnName: string): Set<string> {
  const fnStart = SQL.indexOf(`function ${fnName}(`);
  assert.ok(fnStart > -1, `${fnName} not found in the migration`);
  const body = SQL.slice(fnStart, SQL.indexOf('$$;', fnStart));
  const clause = /role in \(([^)]*)\)/.exec(body);
  assert.ok(clause, `${fnName} has no "role in (…)" clause`);
  return new Set([...clause[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
}

const tsRoles = (predicate: (r: string) => boolean) => new Set(ROLES.filter(predicate));

describe('role model parity (TS ↔ SQL)', () => {
  test('the migration is found and parsed', () => {
    // Without this, a moved file would make every comparison below run against
    // empty sets and pass — a guard that has quietly stopped guarding.
    assert.ok(sqlRolesFor('can_read_clinical').size > 0);
  });

  test('can_read_clinical matches CAN.readClinical', () => {
    assert.deepEqual(tsRoles(CAN.readClinical), sqlRolesFor('can_read_clinical'));
  });

  test('can_read_observations matches CAN.readObservations', () => {
    assert.deepEqual(tsRoles(CAN.readObservations), sqlRolesFor('can_read_observations'));
  });

  test('can_triage matches CAN.triage', () => {
    assert.deepEqual(tsRoles(CAN.triage), sqlRolesFor('can_triage'));
  });

  test('every role in ROLES is allowed by the users_role_check constraint', () => {
    const constraint = /users_role_check[\s\S]*?check \(role in \(([^)]*)\)\)/.exec(SQL);
    assert.ok(constraint, 'users_role_check not found');
    const allowed = new Set([...constraint[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
    for (const role of ROLES) {
      assert.ok(allowed.has(role), `${role} is in ROLES but the database would reject it`);
    }
    assert.equal(allowed.size, ROLES.length, 'the database allows a role TypeScript does not know');
  });

  test('LAB_TECH exists — the workflow it serves had nowhere to live before', () => {
    assert.ok(ROLES.includes('LAB_TECH'));
  });
});

describe('least privilege holds', () => {
  test('a receptionist can register but sees no clinical content', () => {
    assert.equal(CAN.registerPatient('RECEPTIONIST'), true);
    assert.equal(CAN.readClinical('RECEPTIONIST'), false);
    assert.equal(CAN.readObservations('RECEPTIONIST'), false);
    assert.equal(CAN.prescribe('RECEPTIONIST'), false);
    assert.equal(CAN.triage('RECEPTIONIST'), false);
    assert.equal(scopeFor('RECEPTIONIST'), 'IDENTITY');
  });

  test('a receptionist cannot assert an allergy history — it is a clinical act', () => {
    assert.equal(CAN.recordAllergies('RECEPTIONIST'), false);
  });

  test('a nurse triages and sees observations but not the assessment', () => {
    assert.equal(CAN.triage('NURSE'), true);
    assert.equal(CAN.readObservations('NURSE'), true);
    assert.equal(CAN.readClinical('NURSE'), false);
    assert.equal(CAN.prescribe('NURSE'), false);
    assert.equal(scopeFor('NURSE'), 'OBSERVATIONS');
  });

  test('a lab tech sees the indication but not the chart', () => {
    assert.equal(CAN.readObservations('LAB_TECH'), true);
    assert.equal(CAN.readClinical('LAB_TECH'), false);
    assert.equal(CAN.prescribe('LAB_TECH'), false);
    assert.equal(CAN.registerPatient('LAB_TECH'), false);
  });

  test('a clinician has the whole chart and may prescribe', () => {
    assert.equal(CAN.readClinical('CLINICIAN'), true);
    assert.equal(CAN.prescribe('CLINICIAN'), true);
    assert.equal(scopeFor('CLINICIAN'), 'FULL');
  });

  test('an admin has the whole system', () => {
    assert.equal(CAN.readClinical('ADMIN'), true);
    assert.equal(CAN.prescribe('ADMIN'), true);
    assert.equal(CAN.audit('ADMIN'), true);
    assert.equal(scopeFor('ADMIN'), 'FULL');
  });

  test('an auditor reads everything but changes nothing', () => {
    assert.equal(CAN.readClinical('AUDITOR'), true);
    assert.equal(CAN.audit('AUDITOR'), true);
    assert.equal(CAN.prescribe('AUDITOR'), false);
    assert.equal(CAN.triage('AUDITOR'), false);
    assert.equal(CAN.registerPatient('AUDITOR'), false);
  });

  test('a pharmacist has no clinic-side powers — they work in the till', () => {
    assert.equal(CAN.readClinical('PHARMACIST'), false);
    assert.equal(CAN.prescribe('PHARMACIST'), false);
    assert.equal(CAN.registerPatient('PHARMACIST'), false);
  });

  test('an unknown role gets nothing', () => {
    // Fail closed: a role added to the database but not here must not inherit
    // permissions by accident.
    assert.equal(CAN.readClinical('SOMETHING_NEW'), false);
    assert.equal(CAN.readObservations('SOMETHING_NEW'), false);
    assert.equal(scopeFor('SOMETHING_NEW'), 'IDENTITY');
  });

  test('nobody but a clinician or admin prescribes', () => {
    const allowed = ROLES.filter(CAN.prescribe);
    assert.deepEqual(allowed.sort(), ['ADMIN', 'CLINICIAN']);
  });
});

describe('roleLabel', () => {
  test('renders LAB_TECH readably rather than as a constant', () => {
    assert.equal(roleLabel('LAB_TECH'), 'Lab technician');
  });

  test('title-cases the rest', () => {
    assert.equal(roleLabel('CLINICIAN'), 'Clinician');
    assert.equal(roleLabel('RECEPTIONIST'), 'Receptionist');
  });
});
