/**
 * A 12-point sparkline for a stat tile's trend slot.
 *
 * Deliberately austere: no axes, no gridlines, no labels. A sparkline shows
 * SHAPE, not values — the tile's own number carries the magnitude. Anything
 * more turns a glanceable tile into a chart that demands reading.
 *
 * 2px line per the mark spec, drawn in the de-emphasis hue with the final
 * point marked so "where we are now" is unambiguous.
 */
export function Sparkline({
  points,
  className = '',
  tone = 'brand',
}: {
  points: number[];
  className?: string;
  tone?: 'brand' | 'muted';
}) {
  if (points.length < 2) return null;

  const W = 96;
  const H = 28;
  const PAD = 3; // keeps the 2px stroke and the end dot from clipping

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;

  const coords = points.map((v, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
    return [x, y] as const;
  });

  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = coords[coords.length - 1];
  const stroke = tone === 'brand' ? 'var(--brand)' : 'var(--ink-muted)';

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`h-7 w-24 ${className}`}
      // Decorative: the tile's value and delta already state the trend in text,
      // so a screen reader gains nothing from the path geometry.
      aria-hidden
      focusable="false"
    >
      <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={2.5} fill={stroke} />
    </svg>
  );
}
