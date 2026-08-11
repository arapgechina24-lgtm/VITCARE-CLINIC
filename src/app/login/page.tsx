'use client';
import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        // Without this, the emailed link redirects to the project's Site URL,
        // which still points at port 3000 — the pharmacy till, not this app.
        // Supabase honours this override (verified against a real inbox), so
        // the link works without needing dashboard access. See
        // src/app/auth/confirm/page.tsx for the other half.
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
      },
    });
    setBusy(false);
    if (error) return setError(error.message);
    setStage('code');
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
    setBusy(false);
    if (error) return setError(error.message);
    // A hard navigation, not router.push()+refresh(): this is an auth-state
    // boundary — proxy.ts's server-side session check needs the just-set
    // cookie on the very next request, and push()-then-refresh() races the
    // App Router's client cache (confirmed: URL changes to /dashboard but the
    // login page's own content stays on screen). window.location sidesteps
    // that entirely by forcing a real request.
    window.location.href = '/dashboard';
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    window.location.href = '/dashboard';
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-2xl font-bold text-clinic-deep mb-1">Vitcare Clinic</h1>
        <p className="text-sm text-ink/60 mb-6">Staff sign-in</p>

        {usePassword ? (
          <form onSubmit={signInWithPassword} className="space-y-3">
            <input
              type="email"
              required
              autoFocus
              placeholder="you@vitcare.test"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent"
            />
            <input
              type="password"
              required
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-clinic text-white py-2 font-medium disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" onClick={() => setUsePassword(false)} className="text-xs text-ink/50 underline">
              Use email code instead
            </button>
          </form>
        ) : stage === 'email' ? (
          <form onSubmit={sendCode} className="space-y-3">
            <input
              type="email"
              required
              autoFocus
              placeholder="you@vitcare.health"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-clinic text-white py-2 font-medium disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            <button type="button" onClick={() => setUsePassword(true)} className="text-xs text-ink/50 underline">
              Sign in with a password instead
            </button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-3">
            <p className="text-sm text-ink/60">
              Check {email} and click the sign-in link — open it on this device.
            </p>
            {/* The code box only becomes usable once the project's Magic Link
                email template includes {{ .Token }}; the Supabase default is
                link-only. Kept visible (rather than hidden behind a flag) so
                that adding the token to the template needs no code change. */}
            <p className="text-xs text-ink/45">Or, if your email shows a numeric code, enter it here:</p>
            <input
              type="text"
              inputMode="numeric"
              placeholder="12345678"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent tracking-widest"
            />
            <button
              type="submit"
              disabled={busy || code.length === 0}
              className="w-full rounded-lg bg-clinic text-white py-2 font-medium disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Sign in with code'}
            </button>
          </form>
        )}
        {error && <p className="text-sm text-alert mt-3">{error}</p>}
      </div>
    </main>
  );
}
