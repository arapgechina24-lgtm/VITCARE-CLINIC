import { z } from 'zod';

/**
 * Boot-time configuration contract for the clinic.
 *
 * Mirrors src/lib/env.ts in VITCARE-POS. Same reasoning: a half-configured
 * app used to start cleanly and reveal the problem at first use — which here
 * means a clinician pressing "send to pharmacy" and watching it fail.
 *
 * ── WHAT IS REQUIRED, AND WHY SO LITTLE ───────────────────────────────────
 * Only the two Supabase values. That is deliberate, not laziness: this app
 * also runs as a Vercel deployment that holds NO secrets by design — its
 * integration routes fail closed and the Mac's drains do all machine-to-
 * machine work. Demanding POS_SIGNING_SECRET at boot would refuse to start
 * the cloud copy, which is a supported deployment.
 *
 * What IS enforced is that the POS PUSH path is all-or-nothing. Half of it is
 * the dangerous state: the clinic would queue prescriptions it can sign but
 * never deliver, or deliver them and never learn what happened.
 *
 * The PULL path is a separate, smaller configuration: POS_SIGNING_SECRET on
 * its own is complete and valid, because the till calls us and there is
 * nothing to dial out to. See crossFieldProblems for what that cost when the
 * two were conflated.
 *
 * External connections are deliberately not checked here — see the same note
 * in the POS copy. `npm run health` owns reachability.
 */

export type RawEnv = Record<string, string | undefined>;

/** `KEY=` means NOT CONFIGURED, matching how operators actually write these
 *  files and how the POS copy behaves. */
export function normalizeEnv(raw: RawEnv): RawEnv {
  const out: RawEnv = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim().length === 0) continue;
    out[k] = v;
  }
  return out;
}

const nonEmpty = z.string().trim().min(1);
const optionalNonEmpty = z.string().trim().min(1).optional();

export const ServerEnvSchema = z.object({
  // Field-level rules only. Cross-field rules are in crossFieldProblems(),
  // outside the schema, so they still run when a required field is missing —
  // z.superRefine would be skipped and the operator would fix one problem,
  // restart, and meet the next.
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty.url('must be a full URL, e.g. https://xxxx.supabase.co'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,

  SUPABASE_SERVICE_ROLE_KEY: optionalNonEmpty,

  POS_BASE_URL: optionalNonEmpty,
  POS_SIGNING_SECRET: optionalNonEmpty,
  POS_REQUEST_TIMEOUT_MS: optionalNonEmpty,
  OUTBOX_DRAIN_SECRET: optionalNonEmpty,
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function crossFieldProblems(env: RawEnv): string[] {
  const out: string[] = [];
  const set = (v?: string) => typeof v === 'string' && v.trim().length > 0;
  const fail = (path: string, message: string) => out.push(`${path}: ${message}`);

  // The all-or-nothing rule belongs to the PUSH path only.
  //
  // PUSH (clinic → till) genuinely needs all three: somewhere to send
  // (POS_BASE_URL), a secret to sign with (POS_SIGNING_SECRET), and the gate on
  // the drain that triggers sending (OUTBOX_DRAIN_SECRET). Half of that is the
  // dangerous state this rule was written for — prescriptions signed and never
  // delivered, or delivered and never reconciled.
  //
  // PULL (till → clinic, /api/integration/pos/outbox/fetch + /ack) needs
  // POS_SIGNING_SECRET AND NOTHING ELSE. The till comes to us, so there is no
  // base URL to call and no local drain to gate. The original rule predates
  // pull mode and treated that valid configuration as half-configured.
  //
  // This is not hypothetical: on 2026-08-17 the publicly hosted clinic had
  // POS_SIGNING_SECRET set on its own — exactly what pull mode requires — and
  // the old rule threw at boot, taking every route down with a 502 for ~24
  // minutes. The alternative was inventing a POS_BASE_URL pointing at a till
  // the cloud host cannot reach, which would satisfy the schema by lying to it.
  const pushOnly = ['POS_BASE_URL', 'OUTBOX_DRAIN_SECRET'] as const;
  const pushPresent = pushOnly.filter((k) => set(env[k]));
  if (pushPresent.length > 0) {
    // Any push key commits you to the whole push path, signing secret included.
    const missing: string[] = pushOnly.filter((k) => !set(env[k]));
    if (!set(env.POS_SIGNING_SECRET)) missing.push('POS_SIGNING_SECRET');
    for (const k of missing) {
      fail(k, `POS push path is half-configured; missing ${missing.join(', ')}`);
    }
  }

  if (set(env.POS_SIGNING_SECRET) && env.POS_SIGNING_SECRET!.length < 32) {
    fail('POS_SIGNING_SECRET', 'shorter than 32 bytes — too weak for an HMAC key.');
  }

  if (set(env.POS_REQUEST_TIMEOUT_MS) && !/^\d+$/.test(env.POS_REQUEST_TIMEOUT_MS!.trim())) {
    fail('POS_REQUEST_TIMEOUT_MS', 'must be a whole number of milliseconds.');
  }

  return out;
}

export class EnvironmentError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Configuration is invalid:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
    this.name = 'EnvironmentError';
    this.problems = problems;
  }
}

export function parseServerEnv(rawInput: RawEnv): ServerEnv {
  const problems: string[] = [];
  const raw = normalizeEnv(rawInput);

  // A service_role key in a NEXT_PUBLIC_ variable ships to every browser.
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('NEXT_PUBLIC_') && typeof v === 'string' && /service_role/.test(v)) {
      problems.push(`${k}: appears to contain a service_role key, which would be bundled into the browser.`);
    }
  }

  const result = ServerEnvSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }

  problems.push(...crossFieldProblems(raw));

  if (problems.length > 0) throw new EnvironmentError(problems);
  return result.data as ServerEnv;
}

export function assertServerEnv(raw: RawEnv = process.env): ServerEnv {
  return parseServerEnv(raw);
}
