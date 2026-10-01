import * as pdfjs from './vendor/pdf.min.mjs';
import {
  VERSION, deriveDocs, sanitizeName, uniqueFileName, buildPdfBytes, formatBytes, plural,
} from './core.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- state
const state = {
  file: null,
  pdf: null,
  total: 0,
  cur: 1,
  breaks: [],
  names: {}, // keyed by the document's first page
  history: [],
  fit: 'page',
  aspect: 1.414,
  gen: 0, // increments each time a file is opened, to drop stale async work
  previewToken: 0,
  previewTask: null,
  dirty: false,
  modalOpen: false,
};

const thumbsEl = $('thumbs');
const previewWrap = $('previewWrap');
const docListEl = $('docList');
let thumbEls = []; // index = page number
let cutEls = []; // index = page number (cut after that page)
let thumbObserver = null;
let thumbQueue = [];
let thumbRunning = false;
const thumbRendered = new Set();
const thumbVisible = new Set();

// ---------------------------------------------------------------- screens
function showScreen(name) {
  $('welcome').hidden = name !== 'welcome';
  $('loading').hidden = name !== 'loading';
  $('workspace').hidden = name !== 'workspace';
  const ws = name === 'workspace';
  $('btnUndo').hidden = !ws;
  $('btnStartOver').hidden = !ws;
  $('btnOpenAnother').hidden = !ws;
  if (!ws) $('fileinfo').replaceChildren();
}

let toastTimer = null;
function toast(msg, kind = 'info', ms = 4500) {
  const t = $('toast');
  t.className = 'toast' + (kind === 'info' ? '' : ' ' + kind);
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- modal
function openModal({ title, body, buttons = [], dismissible = true }) {
  const back = $('modal');
  $('modalTitle').textContent = title;
  const bodyEl = $('modalBody');
  bodyEl.replaceChildren();
  if (typeof body === 'string') bodyEl.append(el('p', '', body));
  else if (body) bodyEl.append(body);
  const btnWrap = $('modalBtns');
  btnWrap.replaceChildren();
  state.modalOpen = true;
  back.hidden = false;

  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    back.hidden = true;
    state.modalOpen = false;
    document.removeEventListener('keydown', onKey, true);
    resolveFn(value);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) { e.preventDefault(); close('cancel'); }
  };
  document.addEventListener('keydown', onKey, true);
  let first = null;
  for (const b of buttons) {
    const btn = el('button', 'btn ' + (b.kind || ''), b.label);
    btn.addEventListener('click', () => close(b.value));
    btnWrap.append(btn);
    if (!first || b.focus) first = btn;
  }
  btnWrap.hidden = buttons.length === 0;
  if (first) first.focus();
  return { promise, close };
}

async function confirmDialog(title, message, confirmLabel, danger = false) {
  const r = await openModal({
    title,
    body: message,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: confirmLabel, value: 'ok', kind: danger ? 'danger' : 'primary', focus: true },
    ],
  }).promise;
  return r === 'ok';
}

// ---------------------------------------------------------------- opening files
async function looksLikePdf(file) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return true;
  try {
    return (await file.slice(0, 5).text()) === '%PDF-';
  } catch {
    return false;
  }
}

function showDropHint(msg) {
  const h = $('dropHint');
  h.textContent = msg;
  h.hidden = false;
}

async function openFile(file) {
  if (!file) return;
  if (!(await looksLikePdf(file))) {
    const msg = "That doesn't look like a PDF file. If you dragged it from Outlook, try saving the attachment to your Desktop first, then drag it in from there or press Open PDF.";
    if (state.pdf) toast(msg, 'warn', 8000); else { showScreen('welcome'); showDropHint(msg); }
    return;
  }
  $('dropHint').hidden = true;
  const gen = ++state.gen;
  saveDraftNow();
  const hadPdf = !!state.pdf;
  showScreen('loading');
  $('loadingText').textContent = 'Opening your PDF...';

  let pdf;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
  } catch (err) {
    if (gen !== state.gen) return;
    console.error(err);
    let msg = "Sorry, that PDF couldn't be opened. It may be damaged. Try scanning it again.";
    if (err && err.name === 'PasswordException') {
      msg = 'This PDF is password protected. Open it in a PDF viewer, save an unprotected copy, then open that one here.';
    }
    if (hadPdf && state.pdf) { showScreen('workspace'); toast(msg, 'err', 9000); }
    else { showScreen('welcome'); showDropHint(msg); }
    return;
  }
  if (gen !== state.gen) { pdf.destroy(); return; }

  // Replace the previous document
  if (state.pdf) { try { state.pdf.destroy(); } catch {} }
  state.file = file;
  state.pdf = pdf;
  state.total = pdf.numPages;
  state.cur = 1;
  state.breaks = [];
  state.names = {};
  state.history = [];
  state.dirty = false;
  thumbRendered.clear();
  thumbVisible.clear();
  thumbQueue = [];

  try {
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    state.aspect = vp.height / vp.width;
  } catch { state.aspect = 1.414; }

  const restored = loadDraft();

  const info = $('fileinfo');
  info.replaceChildren(
    el('b', '', file.name),
    document.createTextNode(`  -  ${state.total} ${plural(state.total, 'page', 'pages')}  -  ${formatBytes(file.size)}`),
  );

  showScreen('workspace');
  buildThumbs();
  refreshMarks();
  renderDocs();
  updateButtons();
  state.cur = 0; // force goTo to render
  goTo(1);
  if (!restored) focusNameOfDocStartingAt(1);
  if (restored) toast('Welcome back. Your earlier splits and names for this file were restored.', 'info', 6000);
  if (state.total === 1) toast('This PDF has only one page, so there is nothing to split. You can still rename it.', 'warn', 7000);
}

// ---------------------------------------------------------------- thumbnails
function buildThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbsEl.replaceChildren();
  thumbEls = [null];
  cutEls = [null];
  const frag = document.createDocumentFragment();
  for (let p = 1; p <= state.total; p++) {
    const t = el('div', 'thumb');
    t.dataset.p = String(p);
    t.setAttribute('role', 'button');
    t.setAttribute('aria-label', `Page ${p}`);
    const ph = el('div', 'ph');
    ph.style.aspectRatio = `1 / ${state.aspect}`;
    t.append(ph, el('span', 'num', String(p)));
    const badge = el('span', 'docbadge');
    badge.hidden = true;
    t.append(badge);
    thumbEls.push(t);
    frag.append(t);
    if (p < state.total) {
      const c = el('div', 'cutslot');
      c.dataset.p = String(p);
      c.title = 'Click to start a new document on the next page';
      c.append(el('span', 'cuttag'));
      cutEls.push(c);
      frag.append(c);
    } else {
      cutEls.push(null);
    }
  }
  thumbsEl.append(frag);

  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = Number(e.target.dataset.p);
      if (e.isIntersecting) { thumbVisible.add(p); queueThumb(p); }
      else thumbVisible.delete(p);
    }
  }, { root: thumbsEl, rootMargin: '500px 0px' });
  for (let p = 1; p <= state.total; p++) thumbObserver.observe(thumbEls[p]);
}

thumbsEl.addEventListener('click', (e) => {
  const cut = e.target.closest('.cutslot');
  if (cut) { toggleBreak(Number(cut.dataset.p)); return; }
  const t = e.target.closest('.thumb');
  if (t) goTo(Number(t.dataset.p));
});

function queueThumb(p) {
  if (thumbRendered.has(p) || thumbQueue.includes(p)) return;
  thumbQueue.push(p);
  runThumbs();
}

async function runThumbs() {
  if (thumbRunning) return;
  thumbRunning = true;
  const gen = state.gen;
  while (thumbQueue.length && gen === state.gen) {
    // take the queued page closest to the one being viewed
    let best = 0;
    for (let i = 1; i < thumbQueue.length; i++) {
      if (Math.abs(thumbQueue[i] - state.cur) < Math.abs(thumbQueue[best] - state.cur)) best = i;
    }
    const p = thumbQueue.splice(best, 1)[0];
    if (!thumbVisible.has(p) || thumbRendered.has(p)) continue;
    try { await renderThumb(p, gen); } catch (err) { if (gen === state.gen) console.warn('thumb', p, err); }
    await tick();
  }
  thumbRunning = false;
  if (thumbQueue.length) runThumbs(); // pages queued for a newer file while the old loop was finishing
}

async function renderThumb(p, gen) {
  const page = await state.pdf.getPage(p);
  if (gen !== state.gen) return;
  const vp1 = page.getViewport({ scale: 1 });
  const targetW = 220;
  const vp = page.getViewport({ scale: targetW / vp1.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  page.cleanup();
  if (gen !== state.gen) return;
  const ph = thumbEls[p].querySelector('.ph');
  if (ph) ph.replaceWith(canvas);
  thumbRendered.add(p);
}

// ---------------------------------------------------------------- breaks and documents
function docs() { return deriveDocs(state.total, state.breaks); }

function pushHistory(withNames = false) {
  state.history.push({ breaks: [...state.breaks], names: withNames ? { ...state.names } : null });
  if (state.history.length > 100) state.history.shift();
}

// n = the page a document ENDS on (a new document starts on n + 1).
function toggleBreak(n, { focusName = false } = {}) {
  if (!state.pdf || n < 1 || n >= state.total) return;
  pushHistory();
  const i = state.breaks.indexOf(n);
  const adding = i < 0;
  if (adding) state.breaks.push(n); else state.breaks.splice(i, 1);
  state.breaks.sort((a, b) => a - b);
  breaksChanged();
  if (adding && focusName) focusNameOfDocStartingAt(n + 1);
}

// The main action: the page being viewed is the first page of a new document.
function toggleStartHere() {
  if (!state.pdf || state.cur <= 1) return;
  toggleBreak(state.cur - 1, { focusName: true });
}

function focusNameOfDocStartingAt(page) {
  const idx = docs().findIndex((d) => d.start === page);
  const input = idx >= 0 ? docListEl.querySelectorAll('input')[idx] : null;
  if (!input) return;
  input.focus();
  input.scrollIntoView({ block: 'nearest' });
}

function breaksChanged() {
  state.dirty = true;
  refreshMarks();
  renderDocs();
  updateButtons();
  updateCurrentUI();
  saveDraft();
}

function undo() {
  const prev = state.history.pop();
  if (!prev) return;
  state.breaks = prev.breaks;
  if (prev.names) state.names = prev.names;
  breaksChanged();
}

async function startOver() {
  if (!state.pdf) return;
  if (state.breaks.length === 0 && Object.values(state.names).every((v) => !v)) { goTo(1); return; }
  const ok = await confirmDialog('Start over?', 'This removes all your splits and names for this file. You can still press Undo straight afterwards.', 'Start over', true);
  if (!ok) return;
  pushHistory(true);
  state.breaks = [];
  state.names = {};
  breaksChanged();
  goTo(1);
}

function refreshMarks() {
  const list = docs();
  list.forEach((d, i) => {
    const colour = `var(--c${i % 5})`;
    for (let p = d.start; p <= d.end; p++) {
      const t = thumbEls[p];
      t.style.setProperty('--dc', colour);
      const badge = t.querySelector('.docbadge');
      if (p === d.start) { badge.hidden = false; badge.textContent = `Doc ${i + 1}`; }
      else badge.hidden = true;
    }
  });
  for (let p = 1; p < state.total; p++) cutEls[p].classList.toggle('on', state.breaks.includes(p));
}

function docIndexOfPage(p) {
  const list = docs();
  return list.findIndex((d) => p >= d.start && p <= d.end);
}

function renderDocs() {
  const list = docs();
  $('docCount').textContent = String(list.length);
  $('docsHint').hidden = state.breaks.length > 0;
  const cards = list.map((d, i) => {
    const card = el('div', 'doc');
    card.style.setProperty('--dc', `var(--c${i % 5})`);
    card.dataset.i = String(i);
    const head = el('div', 'dochead');
    head.append(el('span', 'title', `Document ${i + 1}`));
    const n = d.end - d.start + 1;
    head.append(el('span', 'range', `From page ${d.start} (${n} ${plural(n, 'page', 'pages')})`));
    const row = el('div', 'namerow');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type a file name';
    input.value = state.names[d.start] || '';
    input.setAttribute('aria-label', `File name for document ${i + 1}`);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => {
      state.names[d.start] = input.value;
      input.classList.remove('invalid');
      state.dirty = true;
      saveDraft();
    });
    input.addEventListener('focus', () => {
      if (state.cur < d.start || state.cur > d.end) goTo(d.start);
      input.select();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      input.blur(); // name done: arrow keys and Enter work on the pages again
    });
    row.append(input, el('span', 'ext', '.pdf'));
    card.append(head, row);
    card.addEventListener('click', (e) => {
      if (e.target === input) return;
      goTo(d.start);
    });
    return card;
  });
  docListEl.replaceChildren(...cards);
  const count = list.length;
  $('btnSave').textContent = count === 1 ? 'Save 1 file' : `Save all (${count} files)`;
  updateActiveDoc();
}

function updateActiveDoc() {
  const idx = docIndexOfPage(state.cur);
  docListEl.querySelectorAll('.doc').forEach((c) => {
    const on = Number(c.dataset.i) === idx;
    c.classList.toggle('active', on);
    if (on) c.scrollIntoView({ block: 'nearest' });
  });
}

function updateButtons() {
  $('btnUndo').disabled = state.history.length === 0;
  $('btnStartOver').disabled = !state.pdf;
  $('btnSave').disabled = !state.pdf;
}

// ---------------------------------------------------------------- navigation and preview
function goTo(p) {
  if (!state.pdf) return;
  p = clamp(p, 1, state.total);
  if (p === state.cur) return;
  state.cur = p;
  previewWrap.scrollTop = 0;
  updateCurrentUI();
  renderPreview();
}

function updateCurrentUI() {
  const p = state.cur;
  if (p < 1) return;
  $('pageLabel').textContent = `Page ${p} of ${state.total}`;
  $('btnPrev').disabled = p <= 1;
  $('btnNext').disabled = p >= state.total;
  thumbEls.forEach((t, i) => { if (t) t.classList.toggle('current', i === p); });
  const t = thumbEls[p];
  if (t) t.scrollIntoView({ block: 'nearest' });
  const btn = $('btnSplit');
  const lab = $('btnSplitLabel');
  if (p <= 1) {
    btn.disabled = true;
    btn.className = 'btn primary';
    lab.textContent = 'Document 1 starts here';
  } else if (state.breaks.includes(p - 1)) {
    btn.disabled = false;
    btn.className = 'btn outline-gold';
    lab.textContent = 'Remove this document start';
  } else {
    btn.disabled = false;
    btn.className = 'btn primary';
    lab.textContent = 'Start a new document here';
  }
  updateActiveDoc();
}

async function renderPreview() {
  if (!state.pdf) return;
  const token = ++state.previewToken;
  if (state.previewTask) { try { state.previewTask.cancel(); } catch {} state.previewTask = null; }
  const pageNum = state.cur;

  let spinnerTimer = setTimeout(() => {
    if (token !== state.previewToken) return;
    if (!previewWrap.querySelector('.pending')) {
      const s = el('div', 'pending');
      s.append(el('div', 'spinner small'));
      previewWrap.append(s);
    }
  }, 150);
  const clearSpinner = () => {
    clearTimeout(spinnerTimer);
    previewWrap.querySelectorAll('.pending').forEach((n) => n.remove());
  };

  try {
    const page = await state.pdf.getPage(pageNum);
    if (token !== state.previewToken) return;
    const availW = Math.max(100, previewWrap.clientWidth - 32);
    const availH = Math.max(100, previewWrap.clientHeight - 32);
    const vp1 = page.getViewport({ scale: 1 });
    let scale = state.fit === 'page'
      ? Math.min(availW / vp1.width, availH / vp1.height)
      : availW / vp1.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let renderScale = scale * dpr;
    const maxPixels = 16e6;
    if (vp1.width * vp1.height * renderScale * renderScale > maxPixels) {
      renderScale = Math.sqrt(maxPixels / (vp1.width * vp1.height));
    }
    const vp = page.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.style.width = `${Math.round(vp1.width * scale)}px`;
    canvas.style.height = `${Math.round(vp1.height * scale)}px`;
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    state.previewTask = task;
    await task.promise;
    if (token !== state.previewToken) return;
    state.previewTask = null;
    previewWrap.classList.toggle('fitpage', state.fit === 'page');
    previewWrap.replaceChildren(canvas);
    previewWrap.dataset.page = String(pageNum);
    // warm the next page
    if (pageNum < state.total) state.pdf.getPage(pageNum + 1).catch(() => {});
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    if (token === state.previewToken) {
      console.error(err);
      toast("Couldn't draw this page. Try another page.", 'err');
    }
  } finally {
    if (token === state.previewToken) clearSpinner();
  }
}

function setFit(mode) {
  if (state.fit === mode) return;
  state.fit = mode;
  $('zoomPage').classList.toggle('on', mode === 'page');
  $('zoomWidth').classList.toggle('on', mode === 'width');
  previewWrap.scrollTop = 0;
  renderPreview();
}

let resizeTimer = null;
new ResizeObserver(() => {
  if (!state.pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderPreview, 150);
}).observe(previewWrap);

// ---------------------------------------------------------------- drafts (so a refresh does not lose work)
function draftKey() {
  const f = state.file;
  return `splitpdf:draft:${f.name}|${f.size}|${f.lastModified}|${state.total}`;
}
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 300);
}
function saveDraftNow() {
  clearTimeout(draftTimer);
  if (!state.file || !state.pdf) return;
  try {
    const hasNames = Object.values(state.names).some((v) => v && v.trim());
    if (!state.breaks.length && !hasNames) { localStorage.removeItem(draftKey()); return; }
    localStorage.setItem(draftKey(), JSON.stringify({ t: Date.now(), breaks: state.breaks, names: state.names }));
    pruneDrafts();
  } catch { /* storage unavailable: carry on without drafts */ }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return false;
    const d = JSON.parse(raw);
    const breaks = (d.breaks || []).filter((n) => Number.isInteger(n) && n >= 1 && n < state.total);
    const names = d.names && typeof d.names === 'object' ? d.names : {};
    if (!breaks.length && !Object.values(names).some((v) => v)) return false;
    state.breaks = [...new Set(breaks)].sort((a, b) => a - b);
    state.names = names;
    return true;
  } catch { return false; }
}
function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch {}
}
function pruneDrafts() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('splitpdf:draft:')) {
        let t = 0;
        try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch {}
        keys.push([k, t]);
      }
    }
    if (keys.length <= 15) return;
    keys.sort((a, b) => a[1] - b[1]);
    for (const [k] of keys.slice(0, keys.length - 15)) localStorage.removeItem(k);
  } catch {}
}

// ---------------------------------------------------------------- saving
async function saveAll() {
  if (!state.pdf || state.modalOpen) return;
  saveDraftNow();
  const list = docs();

  // 1. every document needs a usable name
  const bases = list.map((d) => sanitizeName(state.names[d.start]));
  const missing = bases.findIndex((b) => !b);
  if (missing >= 0) {
    const inputs = [...docListEl.querySelectorAll('input')];
    inputs.forEach((inp, i) => inp.classList.toggle('invalid', !bases[i]));
    inputs[missing].focus();
    inputs[missing].scrollIntoView({ block: 'center' });
    const n = bases.filter((b) => !b).length;
    toast(n === 1 ? `Give Document ${missing + 1} a name first.` : `${n} documents still need a name. Document ${missing + 1} is the first.`, 'warn', 6000);
    return;
  }

  // 2. choose a folder (must happen straight after the click)
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'splitpdf', mode: 'readwrite', startIn: 'documents' });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // he cancelled
    toast("Couldn't open that folder. Please pick a different one.", 'err', 7000);
    return;
  }

  const progressBar = el('div');
  const progressText = el('p', '', 'Reading your PDF...');
  const bar = el('div', 'progress');
  bar.append(progressBar);
  const body = el('div');
  body.append(progressText, bar);
  const modal = openModal({ title: 'Saving your files', body, buttons: [], dismissible: false });

  const saved = [];
  try {
    // existing names in the folder, so nothing is ever overwritten
    const taken = new Set();
    for await (const [name] of dir.entries()) taken.add(name.toLowerCase());

    const srcBytes = new Uint8Array(await state.file.arrayBuffer());
    await tick();
    let srcDoc;
    try {
      srcDoc = await window.PDFLib.PDFDocument.load(srcBytes, { updateMetadata: false });
    } catch (err) {
      if (err && /encrypt/i.test(String(err.message || err.name))) {
        throw new UserError('This PDF has security settings that stop it being split here. Print it to a new PDF (choose "Microsoft Print to PDF"), then open that new file.');
      }
      throw err;
    }

    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      progressText.textContent = `Saving ${i + 1} of ${list.length}...`;
      progressBar.style.width = `${Math.round((i / list.length) * 100)}%`;
      await tick();
      const fileName = uniqueFileName(bases[i], taken);
      const bytes = await buildPdfBytes(window.PDFLib, srcDoc, d.start, d.end);
      if (!bytes || bytes.length < 100) throw new Error('Empty output');
      const fh = await dir.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      const check = await fh.getFile();
      if (check.size !== bytes.length) throw new Error(`Size check failed for ${fileName}`);
      saved.push({ name: fileName, d, size: bytes.length, renamed: fileName.toLowerCase() !== (bases[i] + '.pdf').toLowerCase() });
    }
    progressBar.style.width = '100%';
  } catch (err) {
    modal.close('error');
    console.error(err);
    showSaveError(err, saved);
    return;
  }
  modal.close('done');
  state.dirty = false;
  clearDraft();
  await showSaveDone(dir, saved);
}

class UserError extends Error {}

function showSaveError(err, saved) {
  const body = el('div');
  const msg = err instanceof UserError
    ? err.message
    : (err && err.name === 'NotAllowedError')
      ? "Windows wouldn't let SplitPDF write to that folder. Pick another folder, such as Documents."
      : "Something went wrong while saving. Please try again, or pick a different folder.";
  body.append(el('p', 'note err', msg));
  if (saved.length) {
    body.append(el('p', '', `These ${saved.length === 1 ? 'file was' : 'files were'} saved before the problem:`));
    const ul = el('ul', 'filelist');
    saved.forEach((s) => ul.append(el('li', '', s.name)));
    body.append(ul);
  }
  openModal({ title: "Couldn't finish saving", body, buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }] });
}

async function showSaveDone(dir, saved) {
  const body = el('div');
  const n = saved.length;
  body.append(el('p', 'note ok', `Saved ${n} ${plural(n, 'file', 'files')} to the folder "${dir.name}".`));
  const ul = el('ul', 'filelist');
  saved.forEach((s) => {
    const li = el('li', '', s.name);
    const pages = s.d.end - s.d.start + 1;
    li.append(el('span', '', `${pages} ${plural(pages, 'page', 'pages')}`));
    ul.append(li);
  });
  body.append(ul);
  if (saved.some((s) => s.renamed)) {
    body.append(el('p', 'note warn', 'Some names were already used in that folder, so a number was added to keep your existing files safe.'));
  }
  body.append(el('p', '', 'Your original PDF was not changed.'));
  const r = await openModal({
    title: 'All done',
    body,
    buttons: [
      { label: 'Split another PDF', value: 'again' },
      { label: 'Done', value: 'ok', kind: 'primary', focus: true },
    ],
  }).promise;
  if (r === 'again') resetToWelcome();
}

function resetToWelcome() {
  state.gen++;
  if (state.pdf) { try { state.pdf.destroy(); } catch {} }
  state.pdf = null;
  state.file = null;
  state.breaks = [];
  state.names = {};
  state.history = [];
  state.cur = 1;
  thumbsEl.replaceChildren();
  docListEl.replaceChildren();
  previewWrap.replaceChildren();
  showScreen('welcome');
}

// ---------------------------------------------------------------- input wiring
const fileInput = $('fileInput');
$('btnOpen').addEventListener('click', () => fileInput.click());
$('btnOpenAnother').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (f) openFile(f);
});

$('btnPrev').addEventListener('click', (e) => { goTo(state.cur - 1); e.currentTarget.blur(); });
$('btnNext').addEventListener('click', (e) => { goTo(state.cur + 1); e.currentTarget.blur(); });
$('btnSplit').addEventListener('click', (e) => { toggleStartHere(); e.currentTarget.blur(); });
$('zoomPage').addEventListener('click', (e) => { setFit('page'); e.currentTarget.blur(); });
$('zoomWidth').addEventListener('click', (e) => { setFit('width'); e.currentTarget.blur(); });
$('btnUndo').addEventListener('click', () => undo());
$('btnStartOver').addEventListener('click', () => startOver());
$('btnSave').addEventListener('click', () => saveAll());

window.addEventListener('keydown', (e) => {
  if (state.modalOpen || !state.pdf || $('workspace').hidden) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (ctrl || e.altKey) return;
  const inStage = !!e.target.closest && !!e.target.closest('#stage');
  switch (e.key) {
    case 'ArrowRight':
    case 'PageDown':
      e.preventDefault(); goTo(state.cur + 1); break;
    case 'ArrowLeft':
    case 'PageUp':
      e.preventDefault(); goTo(state.cur - 1); break;
    case 'ArrowDown':
      e.preventDefault();
      if (state.fit === 'width') previewWrap.scrollBy({ top: 90 }); else goTo(state.cur + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (state.fit === 'width') previewWrap.scrollBy({ top: -90 }); else goTo(state.cur - 1);
      break;
    case 'Home': e.preventDefault(); goTo(1); break;
    case 'End': e.preventDefault(); goTo(state.total); break;
    case 'Enter':
      if (tag === 'BUTTON' && !inStage) return; // let header and panel buttons behave normally
      e.preventDefault();
      toggleStartHere();
      break;
    default: break;
  }
});

// drag and drop anywhere on the window
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || state.modalOpen) return;
  e.preventDefault();
  dragDepth++;
  $('dropOverlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('dropOverlay').hidden = true;
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  if (state.modalOpen) return;
  const files = [];
  const dt = e.dataTransfer;
  if (dt.items) {
    for (const it of dt.items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
  }
  if (!files.length && dt.files) files.push(...dt.files);
  if (!files.length) {
    const msg = "That didn't come through. If you dragged it from Outlook, save the attachment to your Desktop first, then drag it in from there or press Open PDF.";
    if (state.pdf) toast(msg, 'warn', 8000); else showDropHint(msg);
    return;
  }
  let chosen = null;
  for (const f of files) { if (await looksLikePdf(f)) { chosen = f; break; } }
  if (!chosen) { await openFile(files[0]); return; } // shows the "not a PDF" message
  if (files.length > 1) toast('Several files were dropped. Opened the first PDF only.', 'info');
  openFile(chosen);
});

// open from "Open with" in File Explorer (installed app only)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    try { openFile(await params.files[0].getFile()); } catch (err) { console.warn(err); }
  });
}

window.addEventListener('beforeunload', (e) => {
  if (state.pdf && state.dirty && state.breaks.length) { e.preventDefault(); e.returnValue = ''; }
});

// install button
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (!window.matchMedia('(display-mode: standalone)').matches) $('btnInstall').hidden = false;
});
$('btnInstall').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch {}
  deferredInstall = null;
  $('btnInstall').hidden = true;
});
window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; });

// ---------------------------------------------------------------- start up
function init() {
  $('version').textContent = `SplitPDF v${VERSION}`;
  if (!('showDirectoryPicker' in window)) {
    $('unsupported').hidden = false;
    $('app').hidden = true;
    $('top').hidden = true;
    return;
  }
  showScreen('welcome');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
