'use client';
import { useEffect, useRef, useState } from 'react';
import { LogOut, ChevronDown } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';

/**
 * Initials for the avatar. Two letters max — three starts looking like a logo.
 *
 * Only word-initial LETTERS count. Real staff names here carry parenthetical
 * suffixes ("Amina Wanjiru (Admin)") and titles ("Dr. Peter Kamau"), and naively
 * taking the last whitespace-separated token rendered the avatar as "A(".
 */
function initials(name: string): string {
  const words = name
    // Drop parenthetical segments ENTIRELY, not just their brackets — merely
    // stripping punctuation left "(Admin)" as the word "Admin", so
    // "Amina Wanjiru (Admin)" still resolved to "AA" instead of "AW".
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, '')) // then drop stray dots/hyphens
    .filter(Boolean)
    .filter((w) => !/^(dr|mr|mrs|ms|sr|prof)$/i.test(w)); // titles aren't identity

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function UserMenu({
  fullName,
  email,
  roleLabel,
}: {
  fullName: string;
  email: string;
  roleLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape. Both, not one — a menu that only
  // closes on click traps keyboard users.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-wash text-2xs font-semibold text-brand-ink">
          {initials(fullName)}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-xs font-medium leading-tight text-ink">{fullName}</span>
          <span className="block truncate text-2xs leading-tight text-ink-muted">{roleLabel}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line px-4 py-3">
            <p className="truncate text-sm font-medium text-ink">{fullName}</p>
            <p className="truncate text-xs text-ink-muted">{email}</p>
            <p className="mt-1.5 inline-block rounded bg-surface-sunken px-1.5 py-0.5 text-2xs font-medium text-ink-secondary">
              {roleLabel}
            </p>
          </div>
          <button
            role="menuitem"
            onClick={async () => {
              await supabase.auth.signOut();
              // Hard navigation across an auth boundary — see login/page.tsx.
              window.location.href = '/login';
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
