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
export const supabase = createBrowserClient(url, anon);
