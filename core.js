// SplitPDF core logic. No DOM access here, so it can be tested in Node.

export const VERSION = '1.0.0';

// breaks: array of page numbers N (1-based). A break at N means "a new document starts after page N".
export function deriveDocs(totalPages, breaks) {
  const sorted = [...new Set(breaks)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n < totalPages)
    .sort((a, b) => a - b);
  const docs = [];
  let start = 1;
  for (const b of sorted) {
    docs.push({ start, end: b });
    start = b + 1;
  }
  docs.push({ start, end: totalPages });
  return docs;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Turns whatever was typed into a safe Windows file name (without extension).
// Returns '' if nothing usable is left.
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[\u0000-\u001f<>:"/\\|?*]/g, ''); // illegal characters
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\.pdf$/i, '').trim(); // we add .pdf ourselves
  s = s.replace(/[. ]+$/g, ''); // Windows disallows trailing dots and spaces
  if (s.length > 120) s = s.slice(0, 120).replace(/[. ]+$/g, '');
  if (!s) return '';
  if (RESERVED.test(s)) s = s + '_';
  return s;
}

// Picks a file name that is not in `taken` (a Set of lowercase file names incl. extension).
// Adds " (2)", " (3)" ... when needed. Adds the chosen name to `taken`.
export function uniqueFileName(base, taken) {
  let name = base + '.pdf';
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${base} (${n}).pdf`;
    n++;
  }
  taken.add(name.toLowerCase());
  return name;
}

// Copies pages [start..end] (1-based, inclusive) of an already loaded pdf-lib document
// into a new document and returns the bytes. Page content is copied as is (no recompression).
export async function buildPdfBytes(PDFLib, srcDoc, start, end) {
  const { PDFDocument } = PDFLib;
  const out = await PDFDocument.create();
  const indices = [];
  for (let i = start - 1; i <= end - 1; i++) indices.push(i);
  const pages = await out.copyPages(srcDoc, indices);
  for (const p of pages) out.addPage(p);
  out.setProducer('SplitPDF');
  out.setCreator('SplitPDF');
  return await out.save();
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function plural(n, one, many) {
  return n === 1 ? one : many;
}
