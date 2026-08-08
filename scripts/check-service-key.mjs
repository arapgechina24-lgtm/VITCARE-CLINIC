#!/usr/bin/env node
/**
 * Exercises every path that depends on SUPABASE_SERVICE_ROLE_KEY.
 *
 *   node scripts/check-service-key.mjs
 *
 * Run this after rotating the key. It distinguishes the three failures that
 * look identical from a distance:
 *
 *   1. the key in .env.local is wrong or revoked
 *   2. the key is fine but the RUNNING SERVICE still holds the old one —
 *      launchd read .env.local at start, so a rotation without a restart
 *      leaves the file correct and the process stale
 *   3. the service is simply not running
 *
 * Failure 2 is the one that bites. Everything on disk looks right, the
 * scripts all pass, and only the live webhook receiver and the drain are
 * broken — which nobody notices until a prescription does not arrive.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(ROOT, '.env.local');
const env = readFileSync(envFile, 'utf8');
const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() || '';

const url = get('NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
const key = get('SUPABASE_SERVICE_ROLE_KEY');
const drainSecret = get('OUTBOX_DRAIN_SECRET');
const APP = 'http://localhost:3001';

let fails = 0;
const ok = (m, extra = '') => console.log(`  ok    ${m}${extra ? `  ${extra}` : ''}`);
const bad = (m, why) => { console.error(`  FAIL  ${m}\n        ${why}`); fails += 1; };

console.log(`\n  project: ${url}`);
console.log(`  key:     ${key ? `${key.slice(0, 11)}… (${key.length} chars, ${key.startsWith('sb_secret_') ? 'modern secret' : key.split('.').length === 3 ? 'legacy JWT' : 'unrecognised'})` : 'MISSING'}\n`);

if (!key) { bad('key present in .env.local', `nothing set in ${envFile}`); process.exit(1); }

const h = { apikey: key, Authorization: `Bearer ${key}` };

/* 1 — does the key work at all? */
let keyWorks = false;
try {
  const res = await fetch(`${url}/rest/v1/sites?select=id&limit=1`, { headers: h });
  if (res.ok) { keyWorks = true; ok('key authenticates against the project'); }
  else bad('key authenticates against the project', `HTTP ${res.status} — revoked, or the wrong project`);
} catch (e) { bad('key authenticates against the project', e.message); }

/* 2 — is it really service-role? integration_outbox has RLS on and NO
 *     client-role policy, so anon/authenticated can never see rows. */
if (keyWorks) {
  try {
    const res = await fetch(`${url}/rest/v1/integration_outbox?select=id&limit=1`, { headers: h });
    if (res.ok && Array.isArray(await res.json())) ok('key carries service-role privilege');
    else bad('key carries service-role privilege', `HTTP ${res.status} — looks like a publishable/anon key`);
  } catch (e) { bad('key carries service-role privilege', e.message); }
}

/* 3 — the SECURITY DEFINER helpers the backup and drift checks depend on. */
for (const fn of ['auth_identity_export', 'function_fingerprints']) {
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
    res.ok ? ok(`rpc ${fn}`) : bad(`rpc ${fn}`, `HTTP ${res.status}`);
  } catch (e) { bad(`rpc ${fn}`, e.message); }
}

/* 4 — is the RUNNING app using a working key? This is the restart check. */
let appUp = false;
try {
  const res = await fetch(`${APP}/login`, { signal: AbortSignal.timeout(5000) });
  appUp = res.ok;
  appUp ? ok('clinic service is up', APP) : bad('clinic service is up', `HTTP ${res.status}`);
} catch {
  bad('clinic service is up', `nothing answering on ${APP} — launchctl list | grep vitcare`);
}

if (appUp) {
  // 503 here means the receiver decided the integration is unconfigured,
  // which is what a missing/blank service key looks like from inside the app.
  try {
    const res = await fetch(`${APP}/api/integration/pos/prescription-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (res.status === 503) bad('running app has a service key', 'receiver answered 503 (integration not configured) — restart the service');
    else if (res.status === 401) ok('running app has a service key', 'receiver rejects unsigned requests (401)');
    else ok('running app has a service key', `receiver answered ${res.status}`);
  } catch (e) { bad('running app has a service key', e.message); }

  if (drainSecret) {
    try {
      const res = await fetch(`${APP}/api/prescriptions/outbox-drain`, {
        method: 'POST', headers: { Authorization: `Bearer ${drainSecret}` }, signal: AbortSignal.timeout(30000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) ok('outbox drain runs', JSON.stringify(body));
      else bad('outbox drain runs', `HTTP ${res.status} ${JSON.stringify(body)} — if the key was just rotated, restart the service`);
    } catch (e) { bad('outbox drain runs', e.message); }
  }
}

if (fails > 0) {
  console.error(`\n  ${fails} check(s) failed.`);
  console.error('  If the key on disk works but the app does not, restart it:');
  console.error('    launchctl unload ~/Library/LaunchAgents/com.vitcare.clinic.plist');
  console.error('    launchctl load   ~/Library/LaunchAgents/com.vitcare.clinic.plist\n');
  process.exit(1);
}
console.log('\n  every service-key path is working.\n');
