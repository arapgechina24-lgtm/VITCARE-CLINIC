/**
 * The workbook writer, tested by taking its own output apart.
 *
 * A hand-rolled file format only earns trust if something reads it back, so
 * these tests walk the zip's local file headers, inflate the entries and parse
 * the sheet XML. The output has also been opened in an independent reader
 * (openpyxl) and by `unzip -t` — this file is what keeps it that way.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  buildXlsx, columnName, crc32, escapeXml, safeSheetName, stripIllegalXml,
} from './xlsx';

/** Walk the local file headers and return { name: contents }. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const csize = buf.readUInt32LE(p + 18);
    const usize = buf.readUInt32LE(p + 22);
    const nlen = buf.readUInt16LE(p + 26);
    const elen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nlen).toString('utf8');
    const start = p + 30 + nlen + elen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    // The header's own claims have to hold, or the file opens on one reader
    // and not another.
    assert.equal(data.length, usize, `${name}: uncompressed size disagrees with the header`);
    assert.equal(crc32(data), crc, `${name}: CRC disagrees with the header`);
    out[name] = data.toString('utf8');
    p = start + csize;
  }
  return out;
}

describe('crc32', () => {
  test('matches the standard check value', () => {
    // The CRC-32 check vector every implementation is measured against.
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  test('is zero for empty input', () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

describe('columnName', () => {
  test('runs A to Z then AA — bijective base-26, not base-26', () => {
    assert.equal(columnName(0), 'A');
    assert.equal(columnName(9), 'J');
    assert.equal(columnName(25), 'Z');
    assert.equal(columnName(26), 'AA');
    assert.equal(columnName(51), 'AZ');
    assert.equal(columnName(52), 'BA');
    assert.equal(columnName(701), 'ZZ');
    assert.equal(columnName(702), 'AAA');
  });
});

describe('stripIllegalXml', () => {
  test('removes control characters XML 1.0 forbids', () => {
    const bell = String.fromCharCode(7);
    const nul = String.fromCharCode(0);
    assert.equal(stripIllegalXml(`a${bell}b${nul}c`), 'abc');
  });

  test('keeps tab, newline and carriage return, which are legal', () => {
    const s = ['a', String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13), 'b'].join('');
    assert.equal(stripIllegalXml(s), s);
  });

  test('leaves ordinary text and non-ASCII alone', () => {
    assert.equal(stripIllegalXml('Wanjirũ — 250 KSh'), 'Wanjirũ — 250 KSh');
  });
});

describe('escapeXml', () => {
  test('escapes the five XML metacharacters', () => {
    assert.equal(escapeXml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  test('escapes the ampersand before the entities it introduces', () => {
    // Escaping < first would turn "a<b" into "a&lt;b" and then the & pass would
    // produce "a&amp;lt;b", which renders as the literal text "&lt;".
    assert.equal(escapeXml('<'), '&lt;');
    assert.equal(escapeXml('&lt;'), '&amp;lt;');
  });
});

describe('safeSheetName', () => {
  test('replaces the characters Excel refuses', () => {
    assert.equal(safeSheetName('Aug/2026:SRK'), 'Aug-2026-SRK');
    assert.equal(safeSheetName('a[b]c*d?e'), 'a-b-c-d-e');
  });

  test('truncates at 31 characters, which is Excel’s limit', () => {
    assert.equal(safeSheetName('x'.repeat(40)).length, 31);
  });

  test('never returns an empty name', () => {
    assert.equal(safeSheetName('   '), 'Sheet1');
    assert.equal(safeSheetName(''), 'Sheet1');
  });
});

describe('buildXlsx', () => {
  const workbook = () =>
    buildXlsx([
      {
        name: 'August 2026',
        headerRow: true,
        widths: [12, 30],
        rows: [
          ['DATE', 'NAME'],
          ['2026-08-01', 'TABITHA KAGOI'],
          [],                                   // the farms' day separator
          ['2026-08-02', 'CALVIN KLEIN'],
        ],
      },
    ]);

  test('produces a zip whose every entry checks out', () => {
    // unzip() asserts each header's size and CRC as it goes.
    const parts = unzip(workbook());
    assert.deepEqual(Object.keys(parts).sort(), [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  test('starts with the zip signature, so it is recognised as one', () => {
    assert.equal(workbook().subarray(0, 2).toString('latin1'), 'PK');
  });

  test('ends with a central directory that points at the right offset', () => {
    const buf = workbook();
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
    const count = buf.readUInt16LE(eocd + 8);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    assert.equal(count, 6);
    assert.equal(cdOffset + cdSize, eocd);
    assert.equal(buf.readUInt32LE(cdOffset), 0x02014b50);
  });

  test('points the sheet relationship at the sheet, not at the stylesheet', () => {
    // Getting these the wrong way round yields a workbook Excel opens with
    // "we found a problem with some content".
    const rels = unzip(workbook())['xl/_rels/workbook.xml.rels'];
    assert.match(rels, /Id="rId1"[^>]*Target="worksheets\/sheet1\.xml"/);
    assert.match(rels, /Id="rId2"[^>]*Target="styles\.xml"/);
  });

  test('declares a content type for every part', () => {
    const ct = unzip(workbook())['[Content_Types].xml'];
    assert.match(ct, /PartName="\/xl\/workbook\.xml"/);
    assert.match(ct, /PartName="\/xl\/styles\.xml"/);
    assert.match(ct, /PartName="\/xl\/worksheets\/sheet1\.xml"/);
  });

  test('writes numbers as numbers and text as inline strings', () => {
    const sheet = unzip(buildXlsx([{ name: 'S', rows: [['NAME', 100]] }]))['xl/worksheets/sheet1.xml'];
    assert.match(sheet, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">NAME<\/t><\/is><\/c>/);
    assert.match(sheet, /<c r="B1"><v>100<\/v><\/c>/);
  });

  test('keeps the blank separator row, so day blocks survive', () => {
    const sheet = unzip(workbook())['xl/worksheets/sheet1.xml'];
    assert.match(sheet, /<row r="3"><\/row>/);
    assert.match(sheet, /<row r="4">/);
  });

  test('skips null and empty cells rather than writing empty ones', () => {
    const sheet = unzip(buildXlsx([{ name: 'S', rows: [[null, '', 'x']] }]))['xl/worksheets/sheet1.xml'];
    assert.equal(sheet.includes('r="A1"'), false);
    assert.equal(sheet.includes('r="B1"'), false);
    assert.match(sheet, /r="C1"/);
  });

  test('bolds and freezes the header row when asked', () => {
    const sheet = unzip(workbook())['xl/worksheets/sheet1.xml'];
    assert.match(sheet, /<c r="A1" s="1"/);
    assert.match(sheet, /<c r="A2" t="inlineStr"/);   // no style on the body
    assert.match(sheet, /state="frozen"/);
  });

  test('writes a number that cannot be represented as text rather than corrupting the file', () => {
    const sheet = unzip(buildXlsx([{ name: 'S', rows: [[Number.NaN, Infinity]] }]))['xl/worksheets/sheet1.xml'];
    assert.equal(sheet.includes('<v>NaN</v>'), false);
    assert.match(sheet, /<is><t>NaN<\/t><\/is>/);
    assert.match(sheet, /<is><t>Infinity<\/t><\/is>/);
  });

  test('escapes cell text so a drug list with an ampersand cannot break the sheet', () => {
    const sheet = unzip(buildXlsx([{ name: 'S', rows: [['diclo & <b>brufen</b>']] }]))['xl/worksheets/sheet1.xml'];
    assert.match(sheet, /diclo &amp; &lt;b&gt;brufen&lt;\/b&gt;/);
  });

  test('always writes at least one sheet, even given none', () => {
    const parts = unzip(buildXlsx([]));
    assert.match(parts['xl/workbook.xml'], /name="Sheet1"/);
  });

  test('is byte-identical when built twice from the same data', () => {
    // The fixed DOS timestamp is what makes this true, and it is what lets a
    // regenerated statement be diffed against the one that was sent.
    assert.deepEqual(workbook(), workbook());
  });
});
