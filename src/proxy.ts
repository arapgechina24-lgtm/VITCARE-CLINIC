import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Server-side auth gate for the clinic staff area. Unlike vitcare-pos there is
 * no Demo Mode fallback here — this app only ever runs against a real,
 * RLS-protected Supabase project, because there is no such thing as
 * non-sensitive demo patient data. Every /dashboard request must carry a
 * valid session or gets redirected to /login.
 *
 * NOTE: this middleware never runs for /api/* routes (matcher below) — that
 * gap bit vitcare-pos (unauthenticated API routes were a real finding in its
 * security audit). Every route under src/app/api/** must call
 * requireStaffSession() itself; see src/lib/api-auth.ts.
 */
export async function proxy(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => {
        cookies.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        cookies.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const to = req.nextUrl.clone();
    to.pathname = '/login';
    return NextResponse.redirect(to);
  }
  return res;
}

export const config = { matcher: ['/dashboard/:path*'] };
