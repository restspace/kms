// Sessionboard import fixtures (workplan 11, §7). Built from the documented
// export/import conventions in docs/15-winning-moves.md §4 — no real
// Sessionboard export has landed yet (§8 step 1 is still pending), so every
// header spelling, status name, and value format here is a best guess marked
// as such in workplan-11 §9. Revisit against a real file when one arrives.
//
// Contract for integration tests: the contact names in SB_CONTACTS_CSV line
// up with the speaker references in SB_SESSIONS_CSV / SB_SESSIONS_EMAILS_CSV
// / SB_HORRORS_CSV — Ada Lovelace, Grace Hopper, and two distinct "Alex
// Smith" contacts (the ambiguous-name trap). Seed contacts from
// SB_CONTACTS_CSV first, then import sessions against that pool, the same
// order the wizard recommends (workplan-11 §5.2 "People first, then
// Sessions").

import { zipSync, strToU8 } from 'fflate';

// ---------------------------------------------------------------------------
// Sessions — names variant
// ---------------------------------------------------------------------------

// Headers use Sessionboard's likely spellings (workplan-11 §4/§9.2). Row
// order below is referenced by index in buildSbSessionsXlsx (rows 1-3).
export const SB_SESSIONS_CSV = [
  'Session ID,Session Name,Description,Session Status,Track,Room,Session Start Time,Session End Time,Speakers,Tags,Session Format',
  // Custom status ("Keynote Confirmed") + multi-speaker cell.
  'SB-1001,Keynote: The Future of Computing,Where we are headed,Keynote Confirmed,AI | Infrastructure,Hall A,2026-09-14 09:00,2026-09-14 10:00,Ada Lovelace | Grace Hopper,AI | Infrastructure,Keynote',
  // Built-in status, single speaker.
  'SB-1002,Scaling Databases at the Edge,Lessons from production,Accepted,Infrastructure,Room B,2026-09-14 11:00,2026-09-14 11:45,Ada Lovelace,Infrastructure,Talk',
  'SB-1003,Panel: Ethics in AI,A moderated discussion,Confirmed,AI,Room C,2026-09-14 13:00,2026-09-14 14:00,Grace Hopper,AI | Ethics,Panel',
  'SB-1004,Workshop: Hands-on Rust,Bring a laptop,Under Review,Infrastructure,Room D,2026-09-15 09:00,2026-09-15 12:00,Alex Smith,Infrastructure,Workshop',
  // Empty Session ID — create-only path (workplan-11 §9.2).
  ',Lightning Talk Ideas,Five minutes each,Draft,,,2026-09-15 15:00,2026-09-15 15:15,,,Lightning Talk',
  // Quoted comma in the title.
  'SB-1006,"Scaling, Fast and Slow",A tale of two systems,Declined,Infrastructure,Room A,2026-09-15 10:00,2026-09-15 10:45,,Infrastructure,Talk',
  'SB-1007,Closing Remarks,Thanks for coming,Accepted,,Hall A,2026-09-16 16:00,2026-09-16 16:30,Grace Hopper,,Keynote',
  'SB-1008,Deep Dive: Serverless at Scale,Cold starts and beyond,Confirmed,Infrastructure | Cloud,Room B,2026-09-16 10:00,2026-09-16 11:00,Ada Lovelace,Infrastructure | Cloud,Talk',
].join('\n');

// ---------------------------------------------------------------------------
// Sessions — emails variant (same shape, Speakers carries emails)
// ---------------------------------------------------------------------------

export const SB_SESSIONS_EMAILS_CSV = [
  'Session ID,Session Name,Description,Session Status,Track,Room,Session Start Time,Session End Time,Speakers,Tags,Session Format',
  'SB-1001,Keynote: The Future of Computing,Where we are headed,Keynote Confirmed,AI | Infrastructure,Hall A,2026-09-14 09:00,2026-09-14 10:00,ada@example.com | grace@example.com,AI | Infrastructure,Keynote',
  'SB-1002,Scaling Databases at the Edge,Lessons from production,Accepted,Infrastructure,Room B,2026-09-14 11:00,2026-09-14 11:45,ada@example.com,Infrastructure,Talk',
  'SB-1003,Panel: Ethics in AI,A moderated discussion,Confirmed,AI,Room C,2026-09-14 13:00,2026-09-14 14:00,grace@example.com,AI | Ethics,Panel',
  'SB-1004,Workshop: Hands-on Rust,Bring a laptop,Under Review,Infrastructure,Room D,2026-09-15 09:00,2026-09-15 12:00,alex.smith1@example.com,Infrastructure,Workshop',
  ',Lightning Talk Ideas,Five minutes each,Draft,,,2026-09-15 15:00,2026-09-15 15:15,,,Lightning Talk',
  'SB-1006,"Scaling, Fast and Slow",A tale of two systems,Declined,Infrastructure,Room A,2026-09-15 10:00,2026-09-15 10:45,,Infrastructure,Talk',
  'SB-1007,Closing Remarks,Thanks for coming,Accepted,,Hall A,2026-09-16 16:00,2026-09-16 16:30,grace@example.com,,Keynote',
  'SB-1008,Deep Dive: Serverless at Scale,Cold starts and beyond,Confirmed,Infrastructure | Cloud,Room B,2026-09-16 10:00,2026-09-16 11:00,ada@example.com,Infrastructure | Cloud,Talk',
].join('\n');

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

// Phone format and Headshot-as-URL per docs/15 §4. "T-Shirt Size" is a
// column nobody maps — exercises the unmapped-column/`extra` path (G7).
export const SB_CONTACTS_CSV = [
  'First Name,Last Name,Email,Company Name,Job Title,Phone Number,Bio,Headshot,T-Shirt Size',
  'Ada,Lovelace,ada@example.com,Analytical Engines,Chief Engineer,+1 (212)555-0101,Wrote the first published algorithm.,https://cdn.example.com/headshots/ada.jpg,M',
  'Grace,Hopper,grace@example.com,US Navy,Rear Admiral,+1 (212)555-0102,Pioneer of machine-independent programming languages.,https://cdn.example.com/headshots/grace.jpg,L',
  // Two distinct "Alex Smith" contacts — the ambiguous-name-match trap.
  'Alex,Smith,alex.smith1@example.com,Northwind Cloud,Platform Engineer,+1 (212)555-0103,,https://cdn.example.com/headshots/alex1.jpg,S',
  'Alex,Smith,alex.smith2@example.com,Contoso Systems,Data Scientist,+1 (212)555-0104,,https://cdn.example.com/headshots/alex2.jpg,XL',
  'Dana,Kowalski,dana@example.com,Kowalski Labs,Principal Researcher,+1 (212)555-0105,,https://cdn.example.com/headshots/dana.jpg,M',
  // Empty email.
  'Sam,Nameless,,Freelance,Consultant,+1 (212)555-0106,,,',
].join('\n');

// ---------------------------------------------------------------------------
// Horrors — the adversarial file
// ---------------------------------------------------------------------------

// Leading UTF-8 BOM + CRLF line endings, built explicitly rather than via
// a plain join so both survive verbatim.
const HORROR_ROWS = [
  'Session ID,Session Name,Description,Session Status,Track,Room,Session Start Time,Session End Time,Speakers,Tags,Session Format',
  // Trap: smart quotes + emoji in the title.
  'SB-3001,“Edge Computing” Rocks 🚀,A curly-quoted title,Accepted,AI,Hall A,2026-09-14 09:00,2026-09-14 10:00,Ada Lovelace,AI,Keynote',
  // Trap: blank required Session Name; also first half of the duplicate-email pair.
  'SB-3002,,No title on this row,Confirmed,Infrastructure,Room B,2026-09-14 11:00,2026-09-14 11:45,grace@example.com,Infrastructure,Talk',
  // Trap: quoted comma in the title + an unknown status + duplicate email
  // (grace@example.com, second occurrence, matching SB-3002).
  'SB-3003,"Scaling, Fast and Slow",A tale of two systems,Mythical Status,Infrastructure,Room C,2026-09-14 13:00,2026-09-14 14:00,grace@example.com,Infrastructure,Talk',
  // Trap: speaker email matching nobody in the contact pool.
  'SB-3004,Panel Discussion,A moderated panel,Accepted,AI,Room D,2026-09-15 09:00,2026-09-15 10:00,nobody@example.com,AI,Panel',
  // Trap: speaker name that matches two contacts (Alex Smith x2) — must warn, not guess.
  'SB-3005,Workshop Session,Bring a laptop,Accepted,Infrastructure,Room A,2026-09-15 11:00,2026-09-15 13:00,Alex Smith,Infrastructure,Workshop',
  // Trap: "Last, First" name in a speakers cell (quoted, since it embeds a comma).
  'SB-3006,Fireside Chat,An informal conversation,Accepted,AI,Hall A,2026-09-15 15:00,2026-09-15 15:30,"Smith, Alex",AI,Talk',
  // Filler row: otherwise-clean, exercises that the horrors aren't so pervasive nothing survives.
  'SB-3007,Closing Notes,Wrap-up remarks,Draft,,Room B,2026-09-16 09:00,2026-09-16 09:15,,,Talk',
  // Trap: mixed name+email speakers cell, and a third occurrence of grace@example.com.
  'SB-3008,Bonus Session,An unscheduled extra,Accepted,Infrastructure,Room C,2026-09-16 10:00,2026-09-16 10:30,Ada Lovelace | grace@example.com,Infrastructure,Talk',
];

export const SB_HORRORS_CSV = '﻿' + HORROR_ROWS.join('\r\n') + '\r\n';

// ---------------------------------------------------------------------------
// XLSX — same session data via the XLSX path, incl. a serial-date cell
// ---------------------------------------------------------------------------

const xmlEscape = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A1-style column ref: 0 → A, 25 → Z, 26 → AA (mirrors src/export.ts). */
const colRef = (index: number): string => {
  let ref = '';
  let n = index;
  do {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return ref;
};

const HEADERS = [
  'Session ID',
  'Session Name',
  'Description',
  'Session Status',
  'Track',
  'Room',
  'Session Start Time',
  'Session End Time',
  'Speakers',
  'Tags',
  'Session Format',
];

// Mirrors the first 3 data rows of SB_SESSIONS_CSV, except row 2's "Session
// Start Time" is an Excel serial-date NUMBER (no t="" attribute, numeric
// <v>) so the serial-date path (G6) is exercised on the XLSX branch.
const XLSX_ROWS: (string | number)[][] = [
  [
    'SB-1001',
    'Keynote: The Future of Computing',
    'Where we are headed',
    'Keynote Confirmed',
    'AI | Infrastructure',
    'Hall A',
    '2026-09-14 09:00',
    '2026-09-14 10:00',
    'Ada Lovelace | Grace Hopper',
    'AI | Infrastructure',
    'Keynote',
  ],
  [
    'SB-1002',
    'Scaling Databases at the Edge',
    'Lessons from production',
    'Accepted',
    'Infrastructure',
    'Room B',
    // Excel serial date for 2026-09-14 09:30 (approx) — the trap cell.
    46297.396,
    '2026-09-14 11:45',
    'Ada Lovelace',
    'Infrastructure',
    'Talk',
  ],
  [
    'SB-1003',
    'Panel: Ethics in AI',
    'A moderated discussion',
    'Confirmed',
    'AI',
    'Room C',
    '2026-09-14 13:00',
    '2026-09-14 14:00',
    'Grace Hopper',
    'AI | Ethics',
    'Panel',
  ],
];

function sbSheetXml(): string {
  const cell = (r: number, cIdx: number, value: string | number): string => {
    const ref = `${colRef(cIdx)}${r}`;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Deliberately no t="" attribute — the raw-serial-number path.
      return `<c r="${ref}"><v>${value}</v></c>`;
    }
    if (value === '' || value === null || value === undefined) return '';
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
  };
  const lines: string[] = [];
  lines.push(`<row r="1">${HEADERS.map((h, i) => cell(1, i, h)).join('')}</row>`);
  XLSX_ROWS.forEach((row, i) => {
    lines.push(`<row r="${i + 2}">${row.map((v, j) => cell(i + 2, j, v)).join('')}</row>`);
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${lines.join('')}</sheetData></worksheet>`
  );
}

/**
 * Minimal real .xlsx (hand-rolled OOXML, zipped with fflate — same recipe as
 * src/export.ts's toXlsx) mirroring the first 3 rows of SB_SESSIONS_CSV,
 * with one raw numeric serial-date cell so parseXlsx's serial-date gap
 * (G6, importer.ts doc comment) is exercised by a real file, not a string.
 */
export function buildSbSessionsXlsx(): Uint8Array {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sessions" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/worksheets/sheet1.xml': strToU8(sbSheetXml()),
  });
}
