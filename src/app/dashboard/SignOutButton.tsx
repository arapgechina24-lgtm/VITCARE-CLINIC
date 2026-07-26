'use client';
import { supabase } from '@/lib/supabase/client';

export default function SignOutButton() {
  return (
    <button
      onClick={async () => {
        await supabase.auth.signOut();
        // Hard navigation — see login/page.tsx's comment on why this auth
        // boundary can't rely on router.push()+refresh().
        window.location.href = '/login';
      }}
      className="underline"
    >
      Sign out
    </button>
  );
}
