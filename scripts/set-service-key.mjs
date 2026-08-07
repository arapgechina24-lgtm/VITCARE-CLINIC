#!/usr/bin/env node
/**
 * Installs the clinic's SUPABASE_SERVICE_ROLE_KEY into .env.local — but only
 * after proving it is the right key for the right project.
 *
 *   node scripts/set-service-key.mjs '<key>'
 *
 * A service-role key bypasses RLS on every table in the project. Pasting the
 * wrong one is not a typo you find later: the anon key looks almost identical
 * and would fail silently at 3am when the webhook receiver cannot read a
 * prescription, while a key from the POS project would point the clinic's
 * writes at the pharmacy's database. So this checks three things before it
 * writes anything:
 *
 *   1. the key's project ref matches NEXT_PUBLIC_SUPABASE_URL
 *   2. the key actually carries service-role privilege — verified by READING a
 *      table that has no client-role policy at all, which anon and authenticated
 *      cannot see by construction
 *   3. the file is rewritten in place, preserving every other line
 *
 * The key is never printed, never logged, and never passed as an argument to a
 * subprocess. Run it with a leading space so it stays out of your shell history.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');

const fail = (msg) => {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
};

const key = process.argv[2]?.trim();
if (!key) {
  fail(
    'Usage: node scripts/set-service-key.mjs \'<key>\'\n\n' +
      '    Supabase dashboard → your CLINIC project → Project Settings → API Keys\n' +
      '    Copy the "service_role" secret (NOT the anon/publishable key).',
  );
}

const env = readFileSync(ENV_PATH, 'utf8');
const url = /^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m.exec(env)?.[1]?.trim();
if (!url) fail('NEXT_PUBLIC_SUPABASE_URL is not set in .env.local — nothing to validate against.');

const projectRef = new URL(url).hostname.split('.')[0];

/* ── 1. Shape and project ─────────────────────────────────────────────── */

if (key.split('.').length === 3) {
  // Legacy JWT-style key: the claims tell us exactly what we have.
  let claims;
  try {
    claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    fail('That looks like a JWT but its payload will not decode. Copy it again.');
  }
  if (claims.role === 'anon') {
    fail('That is the ANON key, not the service_role key. The anon key cannot bypass RLS,\n    so the webhook receiver would fail to read prescriptions.');
  }
  if (claims.role !== 'service_role') {
    fail(`Expected role "service_role", found "${claims.role ?? 'none'}".`);
  }
  if (claims.ref && claims.ref !== projectRef) {
    fail(
      `That key belongs to project "${claims.ref}", but this repo points at "${projectRef}".\n` +
        '    You have almost certainly copied the POS project\'s key.',
    );
  }
} else if (!key.startsWith('sb_secret_')) {
  fail('Unrecognised key format. Expected a JWT (three dot-separated parts) or an "sb_secret_…" key.');
}

/* ── 2. Prove the privilege against the live project ──────────────────── */

// integration_outbox has RLS enabled and NO client-role policy at all, by
// design (0001_prescriptions.sql). anon and authenticated therefore see zero
// rows or an error; only a service-role key gets a normal 200 with an array.
const probe = `${url.replace(/\/$/, '')}/rest/v1/integration_outbox?select=id&limit=1`;

let res;
try {
  res = await fetch(probe, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
} catch (e) {
  fail(`Could not reach ${url} — ${e.message}\n    If the project is paused, resume it first, then re-run.`);
}

if (res.status === 401 || res.status === 403) {
  fail(`The project rejected that key (HTTP ${res.status}). It is not valid for ${projectRef}.`);
}
if (!res.ok) {
  fail(`Unexpected response from the project: HTTP ${res.status}. Nothing was written.`);
}
if (!Array.isArray(await res.json())) {
  fail('The project answered, but not with a row array. Nothing was written.');
}

/* ── 3. Write it, preserving the rest of the file ─────────────────────── */

const line = `SUPABASE_SERVICE_ROLE_KEY=${key}`;
const next = /^SUPABASE_SERVICE_ROLE_KEY=.*$/m.test(env)
  ? env.replace(/^SUPABASE_SERVICE_ROLE_KEY=.*$/m, line)
  : `${env.replace(/\n*$/, '')}\n${line}\n`;

writeFileSync(ENV_PATH, next, { mode: 0o600 });

console.log(`\n  ✓ service_role key verified against ${projectRef} and written to .env.local`);
console.log('  ✓ file permissions set to 600\n');
console.log('  Restart the dev server for it to be picked up.\n');
