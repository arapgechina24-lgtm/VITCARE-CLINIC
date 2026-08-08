#!/usr/bin/env node
/**
 * Detects functions that changed in the database without a migration.
 *
 *   node scripts/check-drift.mjs          compare live against the baseline
 *   node scripts/check-drift.mjs --save   record the current state as baseline
 *
 * WHY THIS EXISTS
 * Three times a function running in this database has differed from the
 * migration file that supposedly defines it — submit_prescription twice,
 * save_consult_notes once. Each was found by hand, and each would have caused
 * a silent regression on a rebuild: an admin quietly losing the ability to
 * prescribe, discovered during disaster recovery.
 *
 * The rule "dump pg_get_functiondef before recreating a function" is correct
 * and useless on its own, because it depends on somebody remembering it at the
 * one moment it matters. This turns it into a check that fails.
 *
 * WHAT IT COMPARES
 * Live digests against a baseline captured FROM the database, not against the
 * .sql files. Postgres reformats and normalises a function when it stores it,
 * so a file and pg_get_functiondef never match byte for byte even when nothing
 * has drifted — comparing them directly would produce constant false alarms
 * and the check would be ignored within a week.
 *
 * So the workflow is: apply migrations, verify behaviour, then `--save`. From
 * then on, any difference means someone changed the database by hand.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(root, 'supabase', 'function-baseline.json');

const env = readFileSync(resolve(root, '.env.local'), 'utf8');
const readEnv = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim();

const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) {
  console.error('\n  ✖ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local\n');
  process.exit(1);
}

const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/function_fingerprints`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: '{}',
});

if (!res.ok) {
  const detail = await res.text().catch(() => '');
  console.error(`\n  ✖ could not read fingerprints (HTTP ${res.status})`);
  if (res.status === 404) console.error('    Is 0015_drift_fingerprints.sql applied?');
  if (detail) console.error(`    ${detail.slice(0, 200)}`);
  console.error('');
  process.exit(1);
}

const live = Object.fromEntries((await res.json()).map((r) => [r.function_name, r.fingerprint]));

if (process.argv.includes('--save')) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), functions: live }, null, 2)}\n`,
  );
  console.log(`\n  ✓ baseline saved — ${Object.keys(live).length} functions\n`);
  console.log('    Commit supabase/function-baseline.json alongside the migration');
  console.log('    that produced it, so the diff shows what changed and why.\n');
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('\n  ✖ No baseline. Run `node scripts/check-drift.mjs --save` after verifying');
  console.error('    the database is in a known-good state.\n');
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const known = baseline.functions ?? {};

const changed = Object.keys(known).filter((f) => live[f] && live[f] !== known[f]);
const added = Object.keys(live).filter((f) => !(f in known));
const removed = Object.keys(known).filter((f) => !(f in live));

if (changed.length === 0 && added.length === 0 && removed.length === 0) {
  console.log(
    `\n  ✓ no drift — ${Object.keys(live).length} functions match the baseline ` +
      `of ${baseline.capturedAt?.slice(0, 10) ?? 'unknown date'}\n`,
  );
  process.exit(0);
}

console.error('\n  ✖ SCHEMA DRIFT\n');
for (const f of changed) console.error(`      CHANGED  ${f}`);
for (const f of added) console.error(`      ADDED    ${f}`);
for (const f of removed) console.error(`      REMOVED  ${f}`);
console.error('\n  If this was an intended migration, re-run with --save and commit the');
console.error('  baseline with it. If it was NOT, the database was changed by hand and');
console.error('  the migration files no longer describe production — dump the live');
console.error('  definition and reconcile it into a migration before doing anything else:');
console.error("      select pg_get_functiondef(oid) from pg_proc where proname = '<name>';\n");
process.exit(1);
