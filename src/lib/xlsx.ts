/**
 * A minimal .xlsx writer.
 *
 * ── WHY THIS EXISTS RATHER THAN A DEPENDENCY ───────────────────────────────
 * The farms are invoiced from a workbook every month, so this code sits on the
 * path of a financial document. The two obvious packages both cost more than
 * they are worth here: SheetJS's npm build lags its releases and has carried
 * advisories, and ExcelJS is over a megabyte before it does anything, which
 * lands in a Netlify function bundle on a free tier. Neither is needed for the
 * one thing we write — a flat grid of numbers and short strings.
 *
 * So this produces the smallest workbook Excel, LibreOffice and Google Sheets
 * all open without complaint, and it is unit-tested by unzipping its own
 * output. Nothing about it is generic: no formulas, no merges, no dates as
 * serial numbers.
 *
 * ── ONE DELIBERATE SIMPLIFICATION ──────────────────────────────────────────
 * INLINE STRINGS, NOT A SHARED STRING TABLE. The shared table exists to
 * de-duplicate repeated text across a large sheet. Ours holds names and drug
 * lists, which barely repeat, and the table is a second index that has to agree
 * with every cell pointing into it. Inline strings cannot disagree with
 * themselves.
 */

import { deflateRawSync } from 'node:zlib';

export type Cell = string | number | null | undefined;

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** Character widths, per column, in the order the columns appear. */
  widths?: number[];
  /** Render row 1 bold and freeze it. */
  headerRow?: boolean;
}

// ── XML ──────────────────────────────────────────────────────────────────
/**
 * Drop characters XML 1.0 does not permit.
 *
 * Control characters below 0x20 other than tab, newline and carriage return are
 * not merely awkward in XML — they are ILLEGAL, and Excel rejects the whole
 * workbook rather than the offending cell. Free-text pharmacy notes are typed
 * on a clinic keyboard and sometimes pasted from elsewhere, so they get
 * stripped.
 *
 * Written as a codepoint test rather than a regex character class on purpose: a
 * class of control characters is invisible in a diff, survives a copy-paste
 * only by luck, and is impossible to review. This says what it means.
 */
export function stripIllegalXml(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const allowedControl = c === 0x09 || c === 0x0a || c === 0x0d;
    if (c < 0x20 && !allowedControl) continue;
    out += ch;
  }
  return out;
}

/** Escape for XML text and attributes both. */
export function escapeXml(s: string): string {
  return stripIllegalXml(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0 → A, 25 → Z, 26 → AA. Spreadsheet columns are BIJECTIVE base-26, which is
 *  not the same as base-26: there is no zero digit, so Z is followed by AA and
 *  not by BA. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellXml(value: Cell, row: number, col: number, style: number): string {
  if (value === null || value === undefined || value === '') return '';
  const ref = `${columnName(col)}${row}`;
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number') {
    // A non-finite number has no <v> representation, and writing one produces a
    // workbook Excel offers to "repair". It becomes text instead, so an
    // operator can see something went wrong upstream rather than losing the row.
    if (Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';
  const freeze = sheet.headerRow
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';
  const rows = sheet.rows
    .map((cells, r) => {
      const rowNo = r + 1;
      const style = sheet.headerRow && r === 0 ? 1 : 0;
      const body = cells.map((c, i) => cellXml(c, rowNo, i, style)).join('');
      // An empty <row/> is what makes the farms' blank separator lines survive
      // the round trip. Omitting empty rows would close up the day blocks their
      // finance offices read the sheet by.
      return `<row r="${rowNo}">${body}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ── ZIP ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  size: number;
  compressed: number;
  crc: number;
  offset: number;
}

/**
 * A fixed DOS timestamp: 1 Jan 1980, the epoch of the zip format itself.
 *
 * Using the real clock would make two workbooks built from the same month
 * differ byte for byte, which defeats the one cheap check available on a
 * generated financial document — regenerate it and see whether anything moved.
 * The mtime of an entry inside a zip interests nobody; the statement's own
 * issue date is on the sheet.
 */
const DOS_TIME = 0;
const DOS_DATE = 33; // year 1980, month 1, day 1

function zip(files: Array<{ name: string; data: string }>): Buffer {
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.from(f.data, 'utf8');
    const deflated = deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed to extract
    local.writeUInt16LE(0, 6);             // general purpose flags
    local.writeUInt16LE(8, 8);             // method 8 = deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length

    chunks.push(local, nameBuf, deflated);
    entries.push({ name: f.name, size: data.length, compressed: deflated.length, crc, offset });
    offset += local.length + nameBuf.length + deflated.length;
  }

  const cdStart = offset;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.compressed, 20);
    central.writeUInt32LE(e.size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra field length
    central.writeUInt16LE(0, 32);          // comment length
    central.writeUInt16LE(0, 34);          // disk number start
    central.writeUInt16LE(0, 36);          // internal attributes
    central.writeUInt32LE(0, 38);          // external attributes
    central.writeUInt32LE(e.offset, 42);
    chunks.push(central, nameBuf);
    offset += central.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                // this disk
  eocd.writeUInt16LE(0, 6);                // disk holding the central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);               // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/**
 * A sheet name Excel will accept.
 *
 * Excel refuses : \ / ? * [ ] outright and truncates past 31 characters — and
 * it refuses the WORKBOOK rather than fixing the name. Our sheets are named
 * after a period, so this is defensive rather than load-bearing, but a workbook
 * that will not open is a worse outcome than a renamed tab.
 */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
  return cleaned.trim() === '' ? 'Sheet1' : cleaned;
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  const names = list.map((s, i) => safeSheetName(s.name || `Sheet${i + 1}`));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // Sheet rIds run 1..n and styles takes n+1. Numbering styles first — the
  // obvious-looking alternative — makes rId1 point at the stylesheet while the
  // workbook claims it is a worksheet, and Excel opens that with
  // "unreadable content".
  const stylesRid = list.length + 1;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
