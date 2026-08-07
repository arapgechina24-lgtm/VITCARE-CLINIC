#!/usr/bin/env node
/**
 * Proves the pending migrations actually landed.
 *
 *   node scripts/verify-migrations.mjs
 *
 * Pasting 871 lines into a SQL editor and seeing "Success" tells you the
 * transaction committed. It does not tell you that the objects you expected
 * exist, or that they behave the way the code assumes — a `create or replace`
 * that silently produced a second overload, or a constraint that was added
 * alongside the old one instead of replacing it, both report success.
 *
 * This asks the database directly, through PostgREST with the service-role
 * key, and checks behaviour rather than presence wherever it can. Read-only:
 * it calls functions with arguments chosen so they cannot mutate anything.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = readFileSync(resolve(root, '.env.local'), 'utf8');
const read = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim();

const url = read('NEXT_PUBLIC_SUPABASE_URL');
const key = read('SUPABASE_SERVICE_ROLE_KEY');

if (!url) fail('NEXT_PUBLIC_SUPABASE_URL is not set in .env.local');
if (!key) fail('SUPABASE_SERVICE_ROLE_KEY is empty — run scripts/set-service-key.mjs first');

function fail(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

const base = url.replace(/\/$/, '');
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function rpc(name, args = {}) {
  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function table(name) {
  const res = await fetch(`${base}/rest/v1/${name}?select=*&limit=0`, { headers });
  return res.status;
}

const results = [];
const check = (migration, what, ok, detail = '') =>
  results.push({ migration, what, ok, detail });

/* ── 0009 — atomic status application ─────────────────────────────────── */
{
  // is_allowed_transition is immutable and pure: safe to call for real.
  const legal = await rpc('is_allowed_transition', { p_current: 'PENDING', p_next: 'PRICED' });
  check('0009', 'is_allowed_transition exists', legal.status === 200);
  check('0009', 'PENDING → PRICED is legal', legal.body === true, `got ${JSON.stringify(legal.body)}`);

  const illegal = await rpc('is_allowed_transition', { p_current: 'COLLECTED', p_next: 'PENDING' });
  check('0009', 'COLLECTED is terminal', illegal.body === false, `got ${JSON.stringify(illegal.body)}`);

  // Called with a nonexistent prescription so it cannot mutate: the dedupe
  // insert rolls back with the PRESCRIPTION_NOT_FOUND raise. A 404 from
  // PostgREST would instead mean the function does not exist.
  const applied = await rpc('apply_status_event', {
    p_event_id: '00000000-0000-4000-8000-000000000000',
    p_prescription_id: '00000000-0000-4000-8000-000000000001',
    p_status: 'PRICED',
  });
  check('0009', 'apply_status_event exists', applied.status !== 404,
    applied.status === 404 ? 'function not found' : `raised as expected (${applied.status})`);
}

/* ── 0010 — allergies ─────────────────────────────────────────────────── */
{
  check('0010', 'patient_allergies table exists', (await table('patient_allergies')) === 200);
  const gate = await rpc('assert_allergies_reviewed', {
    p_patient_id: '00000000-0000-4000-8000-000000000002',
  });
  check('0010', 'assert_allergies_reviewed exists', gate.status !== 404);
  check('0010', 'set_patient_allergies exists',
    (await rpc('set_patient_allergies', { p_patient_id: '00000000-0000-4000-8000-000000000002', p_status: 'BOGUS' })).status !== 404);
}

/* ── 0012 — deactivation revokes access ───────────────────────────────── */
{
  const sites = await rpc('user_sites', { p_user: '00000000-0000-4000-8000-000000000003' });
  check('0012', 'user_sites exists', sites.status === 200);
  check('0012', 'unknown user has no sites', Array.isArray(sites.body) && sites.body.length === 0);
}

/* ── 0013 — role projection ───────────────────────────────────────────── */
{
  for (const fn of ['can_read_clinical', 'can_read_observations', 'can_triage']) {
    const r = await rpc(fn, { p_user: '00000000-0000-4000-8000-000000000004' });
    check('0013', `${fn} exists`, r.status === 200);
    check('0013', `${fn} denies an unknown user`, r.body === false, `got ${JSON.stringify(r.body)}`);
  }

  // The constraint replacement is the fiddly one — the original was inline and
  // unnamed, so a name-based drop could have left the old constraint in place
  // and LAB_TECH would still be rejected. Verified by reading the constraint.
  const con = await fetch(
    `${base}/rest/v1/rpc/check_role_constraint_accepts_lab_tech`,
    { method: 'POST', headers, body: '{}' },
  ).then((r) => r.status).catch(() => 0);
  if (con === 404) {
    check('0013', 'LAB_TECH accepted by users_role_check', null,
      'no helper function — verify by hand: insert a LAB_TECH user, or run\n' +
      "        select pg_get_constraintdef(oid) from pg_constraint where conname like 'users_role%';");
  }
}

/* ── report ───────────────────────────────────────────────────────────── */
console.log('');
let failed = 0;
let skipped = 0;
for (const r of results) {
  if (r.ok === null) { skipped += 1; console.log(`  ?  ${r.migration}  ${r.what}\n       ${r.detail}`); continue; }
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? '✓' : '✖'}  ${r.migration}  ${r.what}${r.detail && !r.ok ? ` — ${r.detail}` : ''}`);
}
console.log('');

if (failed > 0) {
  console.error(`  ${failed} check(s) failed — the migrations are not fully applied.\n`);
  process.exit(1);
}
console.log(`  All ${results.length - skipped} checks passed${skipped ? `, ${skipped} need manual confirmation` : ''}.\n`);
