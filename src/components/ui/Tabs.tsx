'use client';
import { useId, useRef, useState, type ReactNode } from 'react';

/**
 * Accessible tabs, built rather than pulled in as a dependency.
 *
 * The ARIA tab pattern is mostly keyboard behaviour, and getting it right is
 * cheaper than adding a component library to a medical app:
 *   - roving tabindex — exactly one tab is in the tab order, so Tab moves you
 *     PAST the tablist to the panel rather than through every tab
 *   - ←/→ move between tabs and wrap; Home/End jump to first/last
 *   - each tab points at its panel with aria-controls, and the panel points
 *     back with aria-labelledby
 *
 * Panels stay mounted and are hidden with `hidden` rather than unmounted, so
 * switching tabs never loses a half-typed clinical note.
 */
export interface TabDef {
  id: string;
  label: string;
  /** Optional count shown beside the label. */
  count?: number;
  /** Marks a tab whose data has no backend yet. */
  sample?: boolean;
  content: ReactNode;
}

export function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.id);
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const focusTab = (id: string) => {
    setActive(id);
    refs.current[id]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    if (i === -1) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusTab(tabs[(i + 1) % tabs.length].id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusTab(tabs[(i - 1 + tabs.length) % tabs.length].id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(tabs[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(tabs[tabs.length - 1].id);
    }
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="Patient record sections"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-controls={`${base}-panel-${t.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
                selected
                  ? 'border-brand font-medium text-brand-ink'
                  : 'border-transparent text-ink-secondary hover:border-line-strong hover:text-ink'
              }`}
            >
              {t.label}
              {typeof t.count === 'number' && (
                <span
                  className={`tabular rounded px-1.5 py-0.5 text-2xs ${
                    selected ? 'bg-brand-wash text-brand-ink' : 'bg-surface-sunken text-ink-muted'
                  }`}
                >
                  {t.count}
                </span>
              )}
              {t.sample && (
                <span className="rounded bg-warning-wash px-1 py-0.5 text-2xs font-medium text-warning-ink">
                  Sample
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== active}
          // tabIndex 0 so the panel itself is reachable from the tablist —
          // otherwise keyboard users land past the content entirely.
          tabIndex={0}
          className="pt-5 focus-visible:outline-none"
        >
          {t.id === active && t.content}
        </div>
      ))}
    </div>
  );
}
