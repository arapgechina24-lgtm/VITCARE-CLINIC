#!/usr/bin/env node
/**
 * One command that answers "is the whole thing working?"
 *
 *   npm run health
 *
 * WHY THIS EXISTS
 * Two real prescriptions sat undelivered from 3 to 8 August. Nothing was
 * broken loudly: the clinician saw "sent", the pharmacist saw an empty queue,
 * and the only evidence was a `failed` flag in a table nobody opens. Every
 * individual check needed to catch that already existed — they were just
 * scattered across seven scripts nobody runs on a normal day.
 *
 * So the design rule here is: FAIL ON SILENCE. A queue that is not moving, a
 * backup that stopped happening, a drain that stopped ticking — those look
 * identical to a healthy idle system unless something actively measures them.
 * Anything that could be quietly wrong gets a freshness threshold, not just a
 * yes/no.
 *
 * Exit 0 = healthy, 1 = something needs attention.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TILL_ENV = '/Users/arapg/vitcare-pos/.env.local';
const BACKUPS = process.env.VITCARE_BACKUP_DIR || join(process.env.HOME, 'vitcare-backups');
const DRAIN_LOG = join(process.env.HOME, 'Library/Logs/vitcare-drains.log');

const env = (file, key) =>
  existsSync(file) ? (new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1]?.trim() || '') : '';

let fails = 0, warns = 0;
const pass = (m, d = '') => console.log(`  ok    ${m}${d ? `  ${d}` : ''}`);
const warn = (m, d) => { warns += 1; console.log(`  warn  ${m}  ${d}`); };
const fail = (m, d) => { fails += 1; console.log(`  FAIL  ${m}  ${d}`); };
const section = (t) => console.log(`\n  ── ${t} ──`);

const mins = (ms) => Math.round(ms / 60000);
const ago = (d) => `${mins(Date.now() - new Date(d).getTime())} min ago`;

async function rest(base, key, path, extra = {}) {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...extra.headers },
    signal: AbortSignal.timeout(15000),
    ...extra,
  });
  return res;
}

/* ── services ─────────────────────────────────────────────────────────── */
section('services');
let launchctl = '';
try { launchctl = execSync('launchctl list', { encoding: 'utf8' }); } catch { /* ignore */ }
for (const [label, why] of [
  ['com.vitcare.pos', 'the till'],
  ['com.vitcare.clinic', 'the clinic'],
  ['com.vitcare.drains', 'prescription delivery'],
  ['com.vitcare.backup', 'daily backup'],
]) {
  const line = launchctl.split('\n').find((l) => l.endsWith(label));
  if (!line) fail(label, `not loaded — ${why} is not scheduled`);
  else {
    const [, exit] = line.split('\t');
    exit === '0' ? pass(label, why) : warn(label, `last exit ${exit}`);
  }
}

/* ── the apps ─────────────────────────────────────────────────────────── */
section('apps answering');
for (const [name, url] of [['till', 'http://localhost:3000/login'], ['clinic', 'http://localhost:3001/login']]) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    r.ok ? pass(name, url) : fail(name, `HTTP ${r.status}`);
  } catch (e) { fail(name, `unreachable — ${e.message}`); }
}
// Staff use the hostname, so check the hostname, not just loopback.
try {
  const host = execSync('scutil --get LocalHostName', { encoding: 'utf8' }).trim();
  const r = await fetch(`http://${host}.local:3001/login`, { signal: AbortSignal.timeout(8000) });
  r.ok ? pass('mDNS name resolves', `${host}.local`) : warn('mDNS name', `HTTP ${r.status}`);
} catch (e) { warn('mDNS name', `staff bookmarks may not resolve — ${e.message}`); }

/* ── databases ────────────────────────────────────────────────────────── */
section('databases');
const projects = [
  { name: 'clinic', url: env(join(ROOT, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL'), key: env(join(ROOT, '.env.local'), 'SUPABASE_SERVICE_ROLE_KEY') },
  { name: 'pharmacy', url: env(TILL_ENV, 'NEXT_PUBLIC_SUPABASE_URL'), key: env(TILL_ENV, 'SUPABASE_SERVICE_ROLE_KEY') },
];
for (const p of projects) {
  if (!p.url || !p.key) { fail(`${p.name} db`, 'URL or service key missing'); continue; }
  try {
    const r = await rest(p.url.replace(/\/$/, ''), p.key, 'sites?select=id&limit=1');
    // A paused free-tier project is the specific failure worth naming.
    if (r.ok) pass(`${p.name} db reachable`, 'not paused');
    else if (r.status === 404) pass(`${p.name} db reachable`, 'not paused');
    else fail(`${p.name} db`, `HTTP ${r.status} — paused, or the key is revoked`);
  } catch (e) { fail(`${p.name} db`, e.message); }
}

/* ── the queues: what went unnoticed for five days ────────────────────── */
section('prescription queues');
const clinic = projects[0];
if (clinic.url && clinic.key) {
  const base = clinic.url.replace(/\/$/, '');
  try {
    const r = await rest(base, clinic.key, 'integration_outbox?select=id,delivered,failed,attempts,created_at&order=created_at.desc&limit=200');
    const rows = await r.json();
    const failed = rows.filter((x) => x.failed);
    const pending = rows.filter((x) => !x.delivered && !x.failed);
    const stuck = pending.filter((x) => Date.now() - new Date(x.created_at).getTime() > 15 * 60000);

    if (failed.length) fail('clinic outbox', `${failed.length} prescription(s) PERMANENTLY FAILED — never reached the pharmacy`);
    else pass('clinic outbox', 'nothing failed');

    if (stuck.length) fail('clinic outbox', `${stuck.length} pending >15 min (oldest ${ago(stuck.at(-1).created_at)}) — is the drain running?`);
    else if (pending.length) pass('clinic outbox', `${pending.length} in flight`);
    else pass('clinic outbox', 'empty');
  } catch (e) { fail('clinic outbox', e.message); }
}
const pos = projects[1];
if (pos.url && pos.key) {
  const base = pos.url.replace(/\/$/, '');
  try {
    const r = await rest(base, pos.key, 'clinic_status_outbox?select=event_id,delivered,failed,created_at&order=created_at.desc&limit=200');
    if (r.ok) {
      const rows = await r.json();
      const failed = rows.filter((x) => x.failed);
      const stuck = rows.filter((x) => !x.delivered && !x.failed && Date.now() - new Date(x.created_at).getTime() > 15 * 60000);
      if (failed.length) fail('till status outbox', `${failed.length} status event(s) failed — clinicians will not learn what was dispensed`);
      else if (stuck.length) fail('till status outbox', `${stuck.length} stuck >15 min`);
      else pass('till status outbox', 'clear');
    } else {
      // Not a warning. A 4xx here means the query itself is wrong — a renamed
      // column, a revoked grant — so this queue is UNMONITORED, which is the
      // state that let two prescriptions sit for five days. A check that
      // cannot run must be as loud as a check that fails.
      fail('till status outbox', `HTTP ${r.status} — the check is broken, so this queue is UNMONITORED`);
    }
  } catch (e) { fail('till status outbox', `${e.message} — queue UNMONITORED`); }
}

/* ── freshness: the checks that catch a job that quietly stopped ──────── */
section('freshness');
if (existsSync(DRAIN_LOG)) {
  const age = Date.now() - statSync(DRAIN_LOG).mtimeMs;
  age < 5 * 60000 ? pass('drains ticking', `${mins(age)} min ago`)
    : fail('drains ticking', `last run ${mins(age)} min ago — prescriptions are not being delivered`);
} else fail('drains ticking', 'no log — has the drain ever run?');

const manifests = existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((f) => f.startsWith('manifest-')).sort() : [];
if (manifests.length === 0) fail('backups', 'none exist');
else {
  const latest = JSON.parse(readFileSync(join(BACKUPS, manifests.at(-1)), 'utf8'));
  const age = Date.now() - new Date(latest.finishedAt).getTime();
  const hrs = Math.round(age / 3600000);
  if (!latest.ok) fail('backups', 'the most recent backup reported errors');
  else if (age > 36 * 3600000) fail('backups', `newest is ${hrs}h old — the daily job has stopped`);
  else pass('backups', `${hrs}h old, ${manifests.length} kept`);
}

/* ── security posture ─────────────────────────────────────────────────── */
section('security');
try {
  const r = await fetch('http://localhost:3000/api/mpesa/callback', {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
  });
  if (r.status === 401) pass('M-Pesa callback authenticated', 'rejects an unsigned call');
  else if (r.status === 503) fail('M-Pesa callback', 'MPESA_CALLBACK_SECRET not set — payments cannot be confirmed');
  else fail('M-Pesa callback', `HTTP ${r.status} — expected 401`);
} catch (e) { warn('M-Pesa callback', e.message); }

const callbackUrl = env(TILL_ENV, 'MPESA_CALLBACK_URL');
if (callbackUrl.includes('lhr.life') || callbackUrl.includes('trycloudflare')) {
  fail('M-Pesa callback URL', 'points at an EPHEMERAL tunnel — it will die and payments will go unconfirmed');
} else if (callbackUrl.startsWith('https://')) pass('M-Pesa callback URL', 'https');
else warn('M-Pesa callback URL', callbackUrl || 'not set');

/* ── clinical readiness ───────────────────────────────────────────────── */
section('clinical');
if (clinic.url && clinic.key) {
  try {
    const r = await rest(clinic.url.replace(/\/$/, ''), clinic.key, 'patients?select=mrn,full_name,allergy_status');
    const rows = await r.json();
    const blocked = rows.filter((p) => (p.allergy_status ?? 'UNRECORDED') === 'UNRECORDED');
    if (blocked.length) warn('allergy histories', `${blocked.length}/${rows.length} patient(s) UNRECORDED — prescribing blocked for them`);
    else pass('allergy histories', `all ${rows.length} recorded`);
  } catch (e) { warn('allergy histories', e.message); }
}

/* ── verdict ──────────────────────────────────────────────────────────── */
console.log('');
if (fails > 0) { console.log(`  ${fails} failure(s), ${warns} warning(s).\n`); process.exit(1); }
if (warns > 0) { console.log(`  healthy, with ${warns} warning(s).\n`); process.exit(0); }
console.log('  all healthy.\n');
