import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export interface StaffSession {
  userId: string;
  role: string;
}

/** Verifies a real session AND loads the caller's role from `users`.
 *  Every API route touching clinical data must call this first —
 *  src/proxy.ts's matcher only covers /dashboard/:path*, never /api/*. */
export async function requireStaffSession(
  req: NextRequest,
): Promise<{ session: StaffSession } | { error: NextResponse }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createServerClient(url, anon, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} },
  });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const { data: profile } = await supabase.from('users').select('role,active').eq('id', user.id).maybeSingle();
  if (!profile || !profile.active) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  return { session: { userId: user.id, role: profile.role as string } };
}

/** Role gate — call after requireStaffSession succeeds. */
export function requireRole(session: StaffSession, ...allowed: string[]): NextResponse | null {
  if (!allowed.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}
