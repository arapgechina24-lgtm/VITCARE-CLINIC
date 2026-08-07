#!/usr/bin/env node
/**
 * Validates every migration against the REAL PostgreSQL grammar before it can
 * be committed.
 *
 *   node scripts/check-sql.mjs            # all migrations
 *   node scripts/check-sql.mjs 0009 0010  # just these
 *
 * Two passes, because they catch different things:
 *
 *   1. `parse` runs the PostgreSQL parser itself (compiled to WASM), so
 *      dollar-quoted bodies, DO blocks and nested $$ are handled exactly as
 *      the server handles them — not by a regex guessing at statement
 *      boundaries.
 *
 *   2. `parsePlpgsql` runs the plpgsql validator, the same check the server
 *      applies at CREATE FUNCTION time. The outer grammar treats a function
 *      body as an opaque string, so without this pass a syntax error inside
 *      get_patient_record's 90 lines of plpgsql would sail through and only
 *      surface when someone pasted it into a production database.
 *
 * WHAT THIS DOES NOT CHECK: semantics. It will not tell you a column does not
 * exist, a function is missing, or the argument types are wrong — only the
 * server knows that. This is a syntax gate, not a substitute for applying the
 * migration to a branch database first. Said plainly here because a check
 * people over-trust is worse than one they know the limits of.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

let PgQuery;
try {
  PgQuery = (await import('pg-query-emscripten')).default;
} catch {
  // Loud, and a failure — a silently-skipped guard is not a guard. If this
  // fires in CI, install devDependencies.
  console.error('\n  ✖ pg-query-emscripten is not installed — cannot validate SQL.');
  console.error('    npm install\n');
  process.exit(1);
}

const wanted = process.argv.slice(2);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)))
  .sort();

if (files.length === 0) {
  console.error(`\n  ✖ No migrations matched ${wanted.join(', ')}\n`);
  process.exit(1);
}

let failed = 0;
let statements = 0;
let bodies = 0;

for (const file of files) {
  const sql = readFileSync(resolve(DIR, file), 'utf8');

  // A FRESH instance per file. Reusing one across all the migrations stalls
  // partway through — the WASM heap is not reclaimed between parses, and the
  // module wedges rather than erroring, which looks exactly like a hang. One
  // instance per file costs ~100ms and is bounded.
  const pg = await new PgQuery();

  const parsed = pg.parse(sql);
  if (parsed.error) {
    report(file, sql, parsed.error, 'syntax');
    failed += 1;
    continue;
  }
  statements += parsed.parse_tree?.stmts?.length ?? 0;

  const pl = pg.parsePlpgsql(sql);
  if (pl.error) {
    report(file, sql, pl.error, 'plpgsql');
    failed += 1;
    continue;
  }
  bodies += pl.plpgsql_funcs?.length ?? 0;
}

function report(file, sql, error, kind) {
  // cursorpos is a byte offset into the statement the OUTER parser was reading,
  // so it locates a syntax error precisely. The plpgsql validator reports
  // against the function body it was handed, not the file, so the same
  // arithmetic there points at whatever happens to be at that offset in the
  // file — usually the header comment. Printing "line 1" beside a comment sends
  // the reader to the wrong place, which is worse than admitting we don't know.
  if (kind === 'syntax' && error.cursorpos) {
    const line = sql.slice(0, error.cursorpos).split('\n').length;
    console.error(`\n  ✖ ${file} — syntax error at line ${line}: ${error.message}`);
    const text = sql.split('\n')[line - 1];
    if (text) console.error(`      ${text.trim().slice(0, 140)}`);
    return;
  }
  console.error(`\n  ✖ ${file} — error inside a plpgsql function body: ${error.message}`);
  console.error('      The offset is relative to the function body, not the file — search the');
  console.error('      file for the construct named above. Postgres would reject this at');
  console.error('      CREATE FUNCTION time.');
}

if (failed > 0) {
  console.error(`\n  ${failed} of ${files.length} migration(s) failed validation.\n`);
  process.exit(1);
}

console.log(
  `✓ SQL check passed — ${files.length} migration(s), ${statements} statements, ` +
    `${bodies} plpgsql bodies, no syntax errors.`,
);
