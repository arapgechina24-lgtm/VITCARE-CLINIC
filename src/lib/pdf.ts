/**
 * A minimal PDF writer, for the statement and utilisation reports.
 *
 * ── WHY NOT A DEPENDENCY, AND WHY NOT window.print() ───────────────────────
 * The same reasoning as xlsx.ts: pdfkit and its peers are large, and the
 * document we produce is a fixed-layout table with a header and totals. The
 * other tempting option — style the page for print and let the browser save a
 * PDF — puts the output at the mercy of whichever browser and printer driver
 * the clinic happens to have, on a document that goes to a customer. A file the
 * server generates is the same file for everyone.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * No embedded fonts. It uses Helvetica, one of the 14 faces every conforming
 * PDF reader is required to provide, so there is no font program to get wrong
 * and no licence to honour. The cost is that text must be WinAnsi-encodable —
 * see encodeWinAnsi below, which is the one place this could lose information
 * and is written to lose it visibly rather than silently.
 *
 * No compression, no images, no links, no outline. Every object is written out
 * in full and the cross-reference table is built from real byte offsets, which
 * is the part a PDF reader actually validates.
 */

export interface PdfColumn {
  header: string;
  /**
   * Width in points, treated as a MINIMUM for a fixed column and as a share of
   * the leftover space for a flexible one. See fitColumns.
   */
  width: number;
  align?: 'left' | 'right';
  /**
   * Marks a column whose text may be cut to fit — the free-text ones: names,
   * drug lists, lab requests. Columns WITHOUT this are never truncated.
   *
   * That distinction is the whole point. An early draft ellipsized whatever
   * did not fit and rendered a total of KSh 150,000.00 as "150,000..." on a
   * document going to a customer's finance office. A cut name is a nuisance; a
   * cut figure is a misstatement, so a figure column is sized from its widest
   * value and the free-text columns give up the space.
   */
  flex?: boolean;
}

export interface PdfMeta {
  label: string;
  value: string;
}

export interface PdfDoc {
  title: string;
  subtitle?: string;
  /** Key/value pairs printed under the title — period, cap, who issued it. */
  meta?: PdfMeta[];
  columns: PdfColumn[];
  rows: string[][];
  /** Printed in bold at the end of the table. */
  totals?: string[];
  /** Small print at the foot of every page. */
  footer?: string;
  /**
   * Turn the page on its side.
   *
   * The scheme register has ten columns, four of them free text. On portrait A4
   * the only ways to fit it are to drop a column or to squeeze the drug lists
   * down to a few characters, and both amount to withholding part of what the
   * farm is being invoiced for. Landscape fits all ten with room to read them.
   */
  landscape?: boolean;
}

// ── Layout ───────────────────────────────────────────────────────────────
// A4 in points, which is what PDF measures in.
const A4_SHORT = 595.28;
const A4_LONG = 841.89;
const MARGIN = 40;
const BODY_SIZE = 8.5;
const LINE_H = 13;

// ── Text encoding ────────────────────────────────────────────────────────
/**
 * The WinAnsi (CP1252) characters that are NOT Latin-1, mapped from their
 * Unicode code points to their WinAnsi byte.
 *
 * These matter because the text on these reports genuinely contains them: the
 * en dash and the middle dot are used throughout the UI copy, and a currency
 * report is exactly the wrong place for a stray "?" where a punctuation mark
 * should be.
 */
const WINANSI_SPECIALS = new Map<number, number>([
  [0x20ac, 0x80], // euro
  [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], // ellipsis
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89],
  [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e],
  [0x2018, 0x91], [0x2019, 0x92], // curly quotes
  [0x201c, 0x93], [0x201d, 0x94],
  [0x2022, 0x95], // bullet
  [0x2013, 0x96], // en dash
  [0x2014, 0x97], // em dash
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/**
 * Unicode → WinAnsi bytes, the encoding the base-14 fonts use.
 *
 * Anything that cannot be represented becomes '?'. That is a real loss, and it
 * is why it is a '?' and not a silent deletion: a name rendered "Wanjir?" tells
 * the operator something is wrong, whereas "Wanjir" looks like a correct name
 * and would be copied into a letter.
 *
 * The middle dot (U+00B7) needs no entry above — it is 0xB7 in Latin-1 and
 * WinAnsi alike, so the plain range below carries it.
 */
export function encodeWinAnsi(s: string): Buffer {
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0a || cp === 0x0d) { bytes.push(0x20); continue; }
    if (cp >= 0x20 && cp <= 0x7e) { bytes.push(cp); continue; }
    if (cp >= 0xa0 && cp <= 0xff) { bytes.push(cp); continue; }
    const special = WINANSI_SPECIALS.get(cp);
    bytes.push(special ?? 0x3f);
  }
  return Buffer.from(bytes);
}

/** Escape a PDF string literal: backslash, and both parentheses. An unescaped
 *  ')' in a patient's name would close the string early and corrupt the page —
 *  and names with parentheses do reach clinical systems. */
function pdfString(s: string): string {
  return encodeWinAnsi(s)
    .toString('latin1')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// ── Metrics ──────────────────────────────────────────────────────────────
/**
 * Helvetica advance widths, in 1/1000 em, for the printable ASCII range.
 *
 * From the Adobe Font Metrics for Helvetica and Helvetica-Bold. Needed only to
 * decide where to truncate a cell so text does not run into the next column;
 * being a point or two out changes nothing, being absent means every long drug
 * list overprints the column beside it.
 */
const HELV_WIDTHS: Record<string, number> = {};
{
  const groups: Array<[string, number]> = [
    [' !', 278], ['"', 355], ['#$', 556], ['%', 889], ['&', 667], ["'", 191],
    ['()', 333], ['*', 389], ['+', 584], [',', 278], ['-', 333], ['.', 278], ['/', 278],
    ['0123456789', 556], [':;', 278], ['<=>', 584], ['?', 556], ['@', 1015],
    ['ABDEHKNOPQRSUVXY', 667], ['C', 722], ['FG', 611], ['I', 278], ['J', 500],
    ['LZ', 611], ['MW', 833], ['T', 611], ['[]', 278], ['\\', 278], ['^', 469], ['_', 556],
    ['`', 333], ['abcdeghknopqsuy', 556], ['f', 278], ['ijl', 222], ['mw', 778],
    ['r', 333], ['t', 278], ['vxz', 500], ['{}', 334], ['|', 260], ['~', 584],
  ];
  for (const [chars, w] of groups) for (const c of chars) HELV_WIDTHS[c] = w;
}

/** Width of a string at a given size, in points. Unknown characters — the
 *  accented ones — fall back to 556, the width of a lowercase letter, which is
 *  close enough for a truncation decision. */
export function textWidth(s: string, size: number): number {
  let total = 0;
  for (const ch of s) total += HELV_WIDTHS[ch] ?? 556;
  return (total * size) / 1000;
}

/** Cut a string to fit a width, with an ellipsis. Used on the free-text drug
 *  lists, which run to 60 characters and would otherwise overprint. */
export function truncateToWidth(s: string, size: number, maxWidth: number): string {
  if (textWidth(s, size) <= maxWidth) return s;
  const ellipsis = '...';
  const budget = maxWidth - textWidth(ellipsis, size);
  if (budget <= 0) return '';
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch, size) > budget) break;
    out += ch;
  }
  return out + ellipsis;
}

interface Op { s: string }

function esc(s: string): string { return `(${pdfString(s)})`; }

function textOp(x: number, y: number, size: number, font: 'F1' | 'F2', s: string): Op {
  return { s: `BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${esc(s)} Tj ET` };
}

function lineOp(x1: number, y1: number, x2: number, y2: number, grey: number): Op {
  return { s: `${grey} G 0.5 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S` };
}

/** Right-aligned money and counts sit under their headers only if the header is
 *  right-aligned too, so alignment is a property of the COLUMN. */
function cellX(width: number, align: PdfColumn['align'], left: number, text: string, size: number): number {
  return align === 'right' ? left + width - textWidth(text, size) - 4 : left + 4;
}

/**
 * Decide the real width of every column.
 *
 * A fixed column gets whatever its widest value needs — header, body or totals
 * — so nothing in it is ever cut. What is left over is shared between the
 * flexible columns in proportion to the widths the caller asked for. If there
 * is nothing left over, every flexible column falls back to its requested
 * width and the table runs wide; that is a visibly broken layout rather than a
 * quietly wrong number, which is the right way round.
 */
export function pageSize(doc: Pick<PdfDoc, 'landscape'>): { width: number; height: number } {
  return doc.landscape
    ? { width: A4_LONG, height: A4_SHORT }
    : { width: A4_SHORT, height: A4_LONG };
}

/** The width a table has to lay itself out in. */
export function usableWidth(doc: Pick<PdfDoc, 'landscape'>): number {
  return pageSize(doc).width - MARGIN * 2;
}

export function fitColumns(doc: PdfDoc, available: number): number[] {
  const PAD = 8;
  const needed = doc.columns.map((c, i) => {
    let w = textWidth(c.header, 8) + PAD;
    for (const row of doc.rows) w = Math.max(w, textWidth(row[i] ?? '', BODY_SIZE) + PAD);
    if (doc.totals) w = Math.max(w, textWidth(doc.totals[i] ?? '', BODY_SIZE) + PAD);
    return w;
  });

  const fixedTotal = doc.columns.reduce((a, c, i) => (c.flex ? a : a + needed[i]), 0);
  const flexAsked = doc.columns.reduce((a, c) => (c.flex ? a + c.width : a), 0);
  const slack = available - fixedTotal;

  return doc.columns.map((c, i) => {
    if (!c.flex) return needed[i];
    if (flexAsked <= 0 || slack <= 0) return c.width;
    // Never grow a flexible column past what its content needs — the leftover
    // goes to whichever ones are still cutting text.
    return Math.min(needed[i], (c.width / flexAsked) * slack);
  });
}

/**
 * Render the document to PDF bytes.
 *
 * Pages are laid out first and objects written second, because the
 * cross-reference table needs each object's byte offset and there is no way to
 * know those until the content is final.
 */
export function buildPdf(doc: PdfDoc): Buffer {
  const pages: Op[][] = [];
  let ops: Op[] = [];
  let y = 0;

  const { width: PAGE_W, height: PAGE_H } = pageSize(doc);
  const widths = fitColumns(doc, usableWidth(doc));
  const totalWidth = widths.reduce((a, w) => a + w, 0);

  const startPage = () => {
    ops = [];
    y = PAGE_H - MARGIN;
    ops.push(textOp(MARGIN, y, 15, 'F2', doc.title));
    y -= 18;
    if (doc.subtitle) {
      ops.push(textOp(MARGIN, y, 9.5, 'F1', doc.subtitle));
      y -= 14;
    }
    for (const m of doc.meta ?? []) {
      ops.push(textOp(MARGIN, y, 8.5, 'F1', `${m.label}: ${m.value}`));
      y -= 11;
    }
    y -= 6;
    // Column headers
    let x = MARGIN;
    doc.columns.forEach((c, i) => {
      const t = truncateToWidth(c.header, 8, widths[i] - 8);
      ops.push(textOp(cellX(widths[i], c.align, x, t, 8), y, 8, 'F2', t));
      x += widths[i];
    });
    y -= 4;
    ops.push(lineOp(MARGIN, y, MARGIN + totalWidth, y, 0.6));
    y -= LINE_H;
  };

  const endPage = () => { pages.push(ops); };

  startPage();
  for (const row of doc.rows) {
    // Leave room for the totals line and the footer rule.
    if (y < MARGIN + 46) { endPage(); startPage(); }
    let x = MARGIN;
    doc.columns.forEach((c, i) => {
      const raw = row[i] ?? '';
      const t = truncateToWidth(raw, BODY_SIZE, widths[i] - 8);
      ops.push(textOp(cellX(widths[i], c.align, x, t, BODY_SIZE), y, BODY_SIZE, 'F1', t));
      x += widths[i];
    });
    y -= LINE_H;
  }

  if (doc.totals) {
    if (y < MARGIN + 34) { endPage(); startPage(); }
    y += 3;
    ops.push(lineOp(MARGIN, y, MARGIN + totalWidth, y, 0.6));
    y -= LINE_H;
    let x = MARGIN;
    doc.columns.forEach((c, i) => {
      const raw = doc.totals?.[i] ?? '';
      const t = truncateToWidth(raw, BODY_SIZE, widths[i] - 8);
      ops.push(textOp(cellX(widths[i], c.align, x, t, BODY_SIZE), y, BODY_SIZE, 'F2', t));
      x += widths[i];
    });
  }
  endPage();

  // Footer with page numbers, added once the page count is known.
  pages.forEach((page, i) => {
    page.push(lineOp(MARGIN, MARGIN + 16, PAGE_W - MARGIN, MARGIN + 16, 0.8));
    if (doc.footer) page.push(textOp(MARGIN, MARGIN + 4, 7.5, 'F1', doc.footer));
    const label = `Page ${i + 1} of ${pages.length}`;
    page.push(textOp(PAGE_W - MARGIN - textWidth(label, 7.5), MARGIN + 4, 7.5, 'F1', label));
  });

  // ── Objects ────────────────────────────────────────────────────────────
  // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then a Page and a
  // Contents object per page.
  const objects: Buffer[] = [];
  const pageObjIds = pages.map((_, i) => 5 + i * 2);

  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(Buffer.from(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  ));
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));

  pages.forEach((page, i) => {
    const contentId = pageObjIds[i] + 1;
    objects.push(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
    const stream = Buffer.from(page.map((o) => o.s).join('\n'), 'latin1');
    objects.push(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]));
  });

  // ── Serialise, recording byte offsets for the xref table ───────────────
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (b: Buffer) => { chunks.push(b); offset += b.length; };

  push(Buffer.from('%PDF-1.4\n'));
  // A comment of high bytes, which tells a transfer agent this is binary and
  // must not be line-ending-converted. Standard practice, and cheap.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(Buffer.from(`${i + 1} 0 obj\n`));
    push(body);
    push(Buffer.from('\nendobj\n'));
  });

  const xrefStart = offset;
  const lines = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `];
  for (const o of offsets) lines.push(`${String(o).padStart(10, '0')} 00000 n `);
  push(Buffer.from(`${lines.join('\n')}\n`));
  push(Buffer.from(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  ));

  return Buffer.concat(chunks);
}

export const PDF_CONTENT_TYPE = 'application/pdf';
