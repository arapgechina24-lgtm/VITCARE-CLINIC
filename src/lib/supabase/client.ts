'use client';
import { createBrowserClient } from '@supabase/ssr';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are required — unlike vitcare-pos, ' +
      'CLINIC has no offline/demo mode: patient records only ever live in the audited, RLS-protected backend.',
  );
}

// createBrowserClient mirrors the session into cookies (not just localStorage)
// so src/proxy.ts's server-side cookie-based check sees the same session.
//
// flowType 'implicit', not the 'pkce' default. PKCE stores a code_verifier in
// the browser that requested the link, and the emailed link is then only
// redeemable in THAT browser — so a staff member who requests a link on the
// till but opens their mail in a different browser (or on their phone) gets
// "PKCE code verifier not found in storage" and simply cannot sign in. That is
// the normal way people read email, so it isn't an edge case.
//
// The trade: implicit returns the session in the URL fragment rather than via
// a verifier exchange, which is marginally weaker — fragments can linger in
// browser history. It is never sent to a server, /auth/confirm redeems it and
// redirects immediately, and this app is LAN-local for now. A login that works
// beats a marginally stronger one that doesn't.
//
// This becomes moot once `{{ .Token }}` is added to the Magic Link email
// template: the 6-digit code path needs no verifier and no fragment, and is
// strictly better. See the README.
// detectSessionInUrl is off and /auth/confirm reads the fragment itself. Auto-
// detection proved unreliable here (a valid fragment was silently ignored, and
// the page just reported the link expired), and racing the library for the same
// tokens is worse than owning the step outright — this is the one place a URL
// ever carries credentials, so it should be explicit and testable.
export const supabase = createBrowserClient(url, anon, {
  auth: { flowType: 'implicit', detectSessionInUrl: false },
});
