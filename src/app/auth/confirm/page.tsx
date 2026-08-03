'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

/**
 * Landing page for the sign-in link emailed by Supabase.
 *
 * WHY this exists: the project's Magic Link email template is the Supabase
 * default, which contains a link and no `{{ .Token }}` — so the 6-digit code
 * box on /login has nothing to receive until that template is edited in the
 * dashboard. Rather than block every staff login on a dashboard change we
 * don't control, /login passes `emailRedirectTo` pointing here, and this page
 * completes the exchange. Verified empirically: Supabase honours that
 * redirect rather than falling back to the project Site URL (which still
 * points at port 3000 — the pharmacy till, not this app).
 *
 * Two shapes can arrive, so both are handled:
 *   - `?code=…`      PKCE, what @supabase/ssr's browser client requests. The
 *                    code_verifier lives in this browser, so the link must be
 *                    opened on the same device that asked for it.
 *   - `#access_token=…` implicit, which createBrowserClient auto-detects on load.
 */
export default function ConfirmPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let settled = false;
    const toDashboard = () => {
      if (settled) return;
      settled = true;
      // Hard navigation, not router.push — same auth-boundary reason as /login.
      window.location.href = '/dashboard';
    };

    (async () => {
      const url = new URL(window.location.href);

      const description = url.searchParams.get('error_description');
      if (description) {
        setError(description);
        return;
      }

      // Implicit flow (the normal path): Supabase redirects here with the
      // session in the URL fragment. Read it directly rather than relying on
      // the client's auto-detection. Crucially this needs NOTHING stored in
      // this browser, which is what makes a link work when staff request it on
      // the till and open their mail somewhere else.
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const hashError = hash.get('error_description');
      if (hashError) {
        setError(hashError);
        return;
      }
      const accessToken = hash.get('access_token');
      const refreshToken = hash.get('refresh_token');
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) {
          setError(error.message);
          return;
        }
        // Strip the tokens from the address bar before navigating on, so they
        // don't sit in browser history.
        window.history.replaceState({}, '', '/auth/confirm');
        toDashboard();
        return;
      }

      // Legacy PKCE links issued before the switch to implicit may still be in
      // someone's inbox; redeem them if the verifier happens to be present.
      const code = url.searchParams.get('code');
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          setError(
            `${error.message}. If you opened this link on a different device than the one you requested it from, request a new link on that device instead.`,
          );
          return;
        }
        toDashboard();
        return;
      }

      // Implicit flow — the client parses the URL fragment itself on load, so
      // the session may already be there, or may land a tick later.
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        toDashboard();
        return;
      }
      const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session) toDashboard();
      });
      setTimeout(() => {
        listener.subscription.unsubscribe();
        if (!settled) setError('That sign-in link has expired or was already used. Request a new one.');
      }, 8000);
    })();
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="font-display text-2xl font-bold text-clinic-deep mb-1">Vitcare Clinic</h1>
        {error ? (
          <>
            <p className="text-sm text-alert mt-4">{error}</p>
            <a href="/login" className="text-sm text-clinic underline mt-3 inline-block">
              Back to sign in
            </a>
          </>
        ) : (
          <p className="text-sm text-ink/60 mt-4">Signing you in…</p>
        )}
      </div>
    </main>
  );
}
