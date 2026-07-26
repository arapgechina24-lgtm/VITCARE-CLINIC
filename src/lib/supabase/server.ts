import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

/** Server Component / Route Handler client — reads the session from cookies. */
export async function supabaseServer() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createServerClient(url, anon, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list: Array<{ name: string; value: string; options?: CookieOptions }>) => {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options ?? {}));
        } catch {
          // called from a Server Component render — middleware refreshes the
          // session cookie instead; safe to ignore here.
        }
      },
    },
  });
}

/** Service-role client — server-only, bypasses RLS. Never import from a Client Component.
 *  Reserved for the outbox drain worker and the POS webhook receiver, both of
 *  which touch integration_outbox / processed_webhook_events (tables with no
 *  client-role policies at all, by design — see 0001_prescriptions.sql). */
export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}
