'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
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
    router.push('/dashboard');
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-2xl font-bold text-clinic-deep mb-1">Vitcare Clinic</h1>
        <p className="text-sm text-ink/60 mb-6">Staff sign-in</p>

        {stage === 'email' ? (
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
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-3">
            <p className="text-sm text-ink/60">Enter the code sent to {email}</p>
            <input
              type="text"
              required
              autoFocus
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent tracking-widest"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-clinic text-white py-2 font-medium disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
          </form>
        )}
        {error && <p className="text-sm text-alert mt-3">{error}</p>}
      </div>
    </main>
  );
}
