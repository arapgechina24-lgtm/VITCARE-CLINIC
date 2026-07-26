#!/usr/bin/env node
// Phase 0 requirement: RLS is not a follow-up task, it's a merge blocker.
// This scans every migration for `create table ...` and fails the commit if
// any table never gets `alter table <name> enable row level security` in the
// same migration set. Wired as a git pre-commit hook (see scripts/install-hooks.sh).
//
// A table that's meant to be service-role-only (e.g. integration_outbox)
// still has to call ENABLE ROW LEVEL SECURITY — with zero policies attached,
// RLS-with-no-policies denies all rows to anon/authenticated by default,
// which is the correct posture for a service-only table. There's no
// "opt out of this check" table category on purpose.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'supabase', 'migrations');

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const sql = files.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');

const created = new Set(
  [...sql.matchAll(/create table\s+(?:if not exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi)].map((m) => m[1].toLowerCase()),
);
const rlsEnabled = new Set(
  [...sql.matchAll(/alter table\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+enable row level security/gi)].map((m) => m[1].toLowerCase()),
);

const missing = [...created].filter((t) => !rlsEnabled.has(t));

if (missing.length) {
  console.error('✗ RLS check failed — table(s) created without ENABLE ROW LEVEL SECURITY:');
  for (const t of missing) console.error(`  - ${t}`);
  console.error('\nEvery table needs `alter table <name> enable row level security;`, even if it');
  console.error('ends up with zero policies (service-only tables). See supabase/migrations/0000_base_schema.sql.');
  process.exit(1);
}

console.log(`✓ RLS check passed — ${created.size} table(s), all RLS-enabled.`);
