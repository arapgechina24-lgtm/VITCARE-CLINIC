import type { ReactNode } from 'react';

/**
 * The surface everything sits on.
 *
 * One elevation level by default. Nested cards are deliberately not supported
 * — if content needs grouping inside a card, use a `<CardSection>` divider
 * rather than a second shadow. Stacked shadows are the fastest way to make an
 * enterprise UI look cluttered.
 */
export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag
      className={`rounded-xl border border-line bg-surface shadow-sm ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * Card header. `action` is the optional right-hand slot (a link, a filter).
 * The title is deliberately modest — in a data-dense screen the *data* should
 * be the loudest thing, not the furniture around it.
 */
export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Body padding, separated so a card can hold a full-bleed table if it wants. */
export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 pb-5 ${className}`}>{children}</div>;
}

/** A hairline-separated section inside a card — the alternative to nesting cards. */
export function CardSection({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`border-t border-line px-5 py-4 ${className}`}>{children}</div>;
}
