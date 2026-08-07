#!/usr/bin/env node
/**
 * Prints migrations to stdout, in order, for pasting into the Supabase SQL
 * editor.
 *
 *   node scripts/pending-sql.mjs 0009 0010 0011 | pbcopy
 *
 * Supabase's REST API cannot run DDL, and there is no database password in this
 * repo, so migrations are applied by hand. Concatenating them here rather than
 * keeping a combined .sql file in the tree means there is never a second copy
 * of the schema to drift out of date — the migration files stay the only
 * source of truth.
 *
 * Order matters and is taken from the arguments, not from the filesystem, so a
 * dependency (0011 needs 0010's assert_allergies_reviewed) cannot be applied
 * backwards by accident.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const prefixes = process.argv.slice(2);

if (prefixes.length === 0) {
  console.error('\n  Usage: node scripts/pending-sql.mjs <prefix> [prefix…]');
  console.error('  e.g.   node scripts/pending-sql.mjs 0009 0010 0011 | pbcopy\n');
  console.error('  Available:');
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    console.error(`    ${f}`);
  }
  console.error('');
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const chunks = [];

for (const prefix of prefixes) {
  const matches = files.filter((f) => f.startsWith(prefix));
  if (matches.length === 0) {
    console.error(`\n  ✖ No migration starts with "${prefix}".\n`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`\n  ✖ "${prefix}" is ambiguous: ${matches.join(', ')}\n`);
    process.exit(1);
  }
  chunks.push(
    `-- ═══════════════════════════════════════════════════════════════════\n` +
      `-- ${matches[0]}\n` +
      `-- ═══════════════════════════════════════════════════════════════════\n\n` +
      readFileSync(resolve(DIR, matches[0]), 'utf8'),
  );
}

// Applied as one transaction: 0011 replaces submit_prescription to call a
// function 0010 creates. Half-applying that pair leaves prescribing broken.
process.stdout.write(`begin;\n\n${chunks.join('\n\n')}\n\ncommit;\n`);
