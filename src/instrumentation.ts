/**
 * Boot-time configuration gate. Mirrors the POS copy.
 *
 * Does NOT run during `next build`: a build produces an artefact, it does not
 * run a clinic, and demanding real secrets to compile is how CI ends up
 * holding a copy of them.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { assertServerEnv, EnvironmentError } = await import('@/lib/env');
  try {
    assertServerEnv(process.env);
  } catch (e) {
    if (e instanceof EnvironmentError) {
      console.error('\n  ✖ The clinic will not start — configuration is invalid:\n');
      for (const p of e.problems) console.error(`   ·  ${p}\n`);
      console.error('  Fix .env.local, then restart.\n');

      // Throwing alone leaves Next holding the port after printing "Ready",
      // so a broken clinic looks up while serving nothing. Reached via
      // globalThis because this file is also bundled for the Edge runtime,
      // where process.exit does not exist and the bare call is flagged.
      (globalThis as { process?: { exit?: (code: number) => never } }).process?.exit?.(1);
    }
    throw e;
  }
}
