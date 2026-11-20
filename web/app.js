import './polyfills.js'; // must load before PDF.js
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  openBtn: $('openBtn'), emptyOpenBtn: $('emptyOpenBtn'), fileName: $('fileName'),
  voice: $('voiceSelect'), speed: $('speedSelect'),
  play: $('playBtn'), stop: $('stopBtn'), back: $('backBtn'), next: $('nextBtn'), follow: $('followToggle'),
  status: $('statusText'),
  viewer: $('viewer'), pages: $('pages'), empty: $('emptyState'),
};

const api = () => window.pywebview.api;

// ---------------------------------------------------------------- diagnostics (written to app.log)

function log(level, ...parts) {
  const msg = parts.map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : String(p))).join(' ');
  (level === 'error' ? console.error : console.log)(msg);
  try { window.pywebview?.api?.log?.(level, msg); } catch { /* bridge not ready */ }
}
window.addEventListener('error', (e) => log('error', 'JS error:', e.message, `(${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => log('error', 'Unhandled promise rejection:', e.reason));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- PDF.js worker
// PDF.js normally parses in a background worker. Some embedded WebKit views never
// start it, which leaves loading stuck. If the worker isn't ready quickly, load the
// worker code on the main thread instead (PDF.js then skips the Worker entirely).

let pdfWorker = null;
let mainThreadMode = false;

async function getPdfWorker() {
  if (mainThreadMode) return null;
  if (pdfWorker) return pdfWorker;
  const worker = new pdfjsLib.PDFWorker();
  try {
    await withTimeout(worker.promise, 4000, 'PDF worker start');
    log('info', 'PDF.js background worker ready');
    pdfWorker = worker;
    return worker;
  } catch (err) {
    log('warn', `${err.message}; switching PDF.js to main-thread mode`);
    worker.destroy();
    await import('./vendor/pdf.worker.min.mjs'); // defines globalThis.pdfjsWorker
    mainThreadMode = true;
    return null;
  }
}
const hasHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

// ---------------------------------------------------------------- document state

const doc = {
  pdf: null,
  pages: [],        // per page: { index, page, base, viewport, el, gen, rendered, renderPromise, textContent, itemStarts, itemStrs, textDivs }
  text: '',         // all extracted text; offsets below index into this
  spoken: '',       // same as text (same length), with running headers/footers blanked out
  pageStarts: [],   // text offset where each page begins
  sentences: [],    // { start, end }
  divInfo: new WeakMap(), // text-layer span -> { page, item }
  observer: null,
  loadId: 0,
};

// ---------------------------------------------------------------- startup

// The bridge may be ready before this module finishes loading, so handle both orders.
let started = false;
function boot() {
  if (started || !window.pywebview?.api?.init) return;
  started = true;
  init();
}
window.addEventListener('pywebviewready', boot);
boot();

async function init() {
  const cfg = await api().init();
  for (const v of cfg.voices) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = prettyVoice(v);
    els.voice.append(opt);
  }
  if (!cfg.voices.length) {
    setStatus('No voices found. Download one into the voices folder (see README).', true);
  } else {
    els.voice.value = cfg.voice;
  }
  els.speed.value = String(cfg.speed);
  if (!els.speed.value) els.speed.value = '1';

  els.openBtn.addEventListener('click', openPdf);
  els.emptyOpenBtn.addEventListener('click', openPdf);
  els.play.addEventListener('click', onPlayButton);
  els.stop.addEventListener('click', () => player.stopPlayback(true));
  els.back.addEventListener('click', () => player.skip(-1));
  els.next.addEventListener('click', () => player.skip(1));
  els.voice.addEventListener('change', saveSettings);
  els.speed.addEventListener('change', saveSettings);
  els.follow.addEventListener('change', () => {
    if (els.follow.checked && marks.playing) scrollSpanIntoView(marks.playing);
  });
  wireViewer();
  wireKeys();

  openPdf(); // straight into the file picker, as launched from the Desktop
}

function prettyVoice(name) {
  // en_US-lessac-high -> Lessac (US, high)
  const m = name.match(/^([a-z]{2})_([A-Z]{2})-(.+)-(x_low|low|medium|high)$/);
  if (!m) return name;
  const speaker = m[3].replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${speaker} (${m[2]}, ${m[4].replace('_', '-')})`;
}

function saveSettings() {
  api().save_settings(els.voice.value, parseFloat(els.speed.value));
  if (player.ctx) setStatus('Voice and speed changes apply the next time you press Play from a marked word.');
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// ---------------------------------------------------------------- opening a PDF

async function openPdf() {
  const res = await api().pick_pdf();
  if (!res) return;
  if (res.error) {
    setStatus(res.error, true);
    return;
  }
  player.stopPlayback(false);
  await loadDocument(res.url, res.name, res.resume);
}

async function loadDocument(url, name, resume = null) {
  const loadId = ++doc.loadId;
  doc.observer?.disconnect();
  if (doc.pdf) doc.pdf.loadingTask.destroy().catch(() => {}); // free the previous document
  Object.assign(doc, { pdf: null, pages: [], text: '', spoken: '', pageStarts: [], sentences: [], divInfo: new WeakMap() });
  els.pages.replaceChildren();
  els.empty.hidden = true;
  els.fileName.textContent = name;
  els.play.disabled = true;
  clearHighlights();
  setStatus('Opening…');

  let pdf;
  try {
    // Read the whole local file in one request; simpler and more reliable than
    // PDF.js's range/streaming loader for a file served from this machine.
    const resp = await withTimeout(fetch(url), 30000, 'Reading the file');
    if (!resp.ok) throw new Error(`file server returned ${resp.status}`);
    const data = new Uint8Array(await resp.arrayBuffer());
    log('info', `Fetched PDF: ${data.length.toLocaleString()} bytes`);
    if (loadId !== doc.loadId) return;

    const worker = await getPdfWorker();
    const task = pdfjsLib.getDocument(worker ? { data, worker } : { data });
    pdf = await withTimeout(task.promise, 60000, 'Parsing the PDF');
    log('info', `Parsed PDF: ${pdf.numPages} pages (${mainThreadMode ? 'main-thread' : 'worker'} mode)`);
  } catch (err) {
    log('error', 'Open failed:', err);
    setStatus(`Could not open this PDF: ${err.message}`, true);
    els.empty.hidden = false;
    return;
  }
  if (loadId !== doc.loadId) return pdf.loadingTask.destroy().catch(() => {});
  doc.pdf = pdf;

  // Load pages and their text in small parallel batches.
  const n = pdf.numPages;
  const loaded = new Array(n);
  let textErrors = 0;
  const BATCH = 8;
  for (let i = 0; i < n; i += BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(n, i + BATCH); j++) {
      batch.push((async () => {
        const page = await pdf.getPage(j + 1);
        let textContent;
        try {
          textContent = await page.getTextContent();
        } catch (err) {
          textErrors++;
          if (textErrors <= 3) log('warn', `Text extraction failed on page ${j + 1}:`, err);
          textContent = { items: [], styles: {} }; // show the page, just not clickable
        }
        loaded[j] = { page, textContent };
      })());
    }
    try {
      await withTimeout(Promise.all(batch), 60000, `Reading pages ${i + 1}-${Math.min(n, i + BATCH)}`);
    } catch (err) {
      log('error', 'Page loading failed:', err);
      setStatus(`Could not read this PDF's pages: ${err.message}`, true);
      return;
    }
    if (loadId !== doc.loadId) return;
    setStatus(`Reading pages… ${Math.min(n, i + BATCH)} / ${n}`);
  }

  // Build page placeholders and the combined text with per-item offsets.
  const width = fitWidth();
  lastWidth = width;
  const lines = []; // { page, start, end, y } per text line, for header/footer detection
  let text = '';
  loaded.forEach(({ page, textContent }, index) => {
    const base = page.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = String(index);
    els.pages.append(el);

    doc.pageStarts.push(text.length);
    const itemStarts = [];
    const itemStrs = [];
    let line = null; // the line being built
    for (const item of textContent.items) {
      if (item.str === undefined) continue; // marked-content markers have no text div
      if (!line && item.str.trim()) {
        const [, y] = base.convertToViewportPoint(item.transform[4], item.transform[5]);
        line = { page: index, start: text.length, y: y / base.height };
      }
      itemStarts.push(text.length);
      itemStrs.push(item.str);
      text += item.str;
      if (item.hasEOL) {
        if (line) lines.push({ ...line, end: text.length });
        line = null;
        text += '\n';
      }
    }
    if (line) lines.push({ ...line, end: text.length });
    text += '\n';

    const pg = { index, page, base, el, gen: 0, rendered: false, renderPromise: null,
      textContent, itemStarts, itemStrs, textDivs: null, viewport: null };
    sizePage(pg, width);
    doc.pages.push(pg);
  });
  doc.text = text;
  doc.spoken = blankRunningLines(text, lines);
  doc.sentences = segmentSentences(doc.spoken);

  doc.observer = new IntersectionObserver(onIntersect, { root: els.viewer, rootMargin: '1200px 0px' });
  doc.pages.forEach((pg) => doc.observer.observe(pg.el));
  els.viewer.scrollTop = 0;

  if (textErrors) log('warn', `Text extraction failed on ${textErrors} of ${n} pages`);
  if (!doc.sentences.length && textErrors) {
    setStatus(`Couldn't read the text in this PDF (see app.log).`, true);
    return;
  }
  if (!doc.sentences.length) {
    setStatus('No selectable text found. This PDF is probably scanned and needs OCR before it can be read aloud.', true);
    return;
  }
  els.play.disabled = false;
  setStatus('Click a word to read from there, or select a passage to hear just that. Then press Play (or Space).');
  if (Number.isInteger(resume) && resume > 0 && resume < text.length) await resumeAt(resume, loadId);
}

// Put the start marker where reading last reached in this PDF.
async function resumeAt(offset, loadId) {
  const idx = sentenceForStart(offset);
  const word = idx >= 0 && wordAt(Math.max(offset, doc.sentences[idx].start));
  if (!word) return;
  const pg = doc.pages[pageOfOffset(word.start)];
  els.viewer.scrollTop = pg.el.offsetTop;
  await renderPage(pg);
  if (loadId !== doc.loadId || player.ctx || startMarker) return; // user already moved on
  setMarker({ start: word.start, end: word.end, passage: false });
  scrollSpanIntoView(word);
  setStatus(`Resuming where you left off (page ${pg.index + 1}). Press Play or Space, or click a word to start elsewhere.`);
}

// ---------------------------------------------------------------- headers and footers

const EDGE_BAND = 0.1;   // top/bottom fraction of a page where running headers/footers sit
const MIN_REPEATS = 3;   // pages a line must repeat on to count as a header/footer

// Running headers and footers ("Chapter 3 · Project Scope", "12 | Principles of PM")
// would otherwise be read aloud on every page, often mid-sentence. Blank out lines
// near the top or bottom of a page whose text, ignoring numbers, repeats across pages.
function blankRunningLines(text, lines) {
  const keyOf = (ln) => text.slice(ln.start, ln.end).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const edge = lines.filter((ln) => ln.y < EDGE_BAND || ln.y > 1 - EDGE_BAND);
  const pagesByKey = new Map();
  for (const ln of edge) {
    const key = keyOf(ln);
    if (!/\p{L}/u.test(key)) continue; // bare page numbers are skipped by the engine anyway
    if (!pagesByKey.has(key)) pagesByKey.set(key, new Set());
    pagesByKey.get(key).add(ln.page);
  }
  const chars = text.split('');
  let blanked = 0;
  for (const ln of edge) {
    if ((pagesByKey.get(keyOf(ln))?.size ?? 0) < MIN_REPEATS) continue;
    for (let i = ln.start; i < ln.end; i++) chars[i] = ' ';
    blanked++;
  }
  if (blanked) log('info', `Skipping ${blanked} running header/footer lines`);
  return chars.join('');
}

// ---------------------------------------------------------------- sentences

const MAX_SENTENCE = 300; // longer runs (tables, lists without punctuation) are split up

function segmentSentences(text) {
  // Line breaks inside a sentence would split it, so segment a copy with them
  // turned into spaces (same length, so offsets still match the original text).
  const flat = text.replace(/\n/g, ' ');
  const spans = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    for (const s of seg.segment(flat)) spans.push([s.index, s.index + s.segment.length]);
  } else {
    const re = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g;
    let m;
    while ((m = re.exec(flat))) spans.push([m.index, m.index + m[0].length]);
  }
  const out = [];
  for (let [start, end] of spans) {
    while (start < end && /\s/.test(flat[start])) start++;
    while (end > start && /\s/.test(flat[end - 1])) end--;
    // Very long "sentences" are slow to synthesise and make Stop/Play-from-here lag.
    while (end - start > MAX_SENTENCE) {
      const cut = splitPoint(flat, start, start + MAX_SENTENCE);
      out.push({ start, end: cut });
      start = cut;
      while (start < end && /\s/.test(flat[start])) start++;
    }
    if (end > start) out.push({ start, end });
  }
  return out;
}

// Where to break flat[start, limit): after the last clause punctuation, else the last
// space, in the second half of the window; otherwise a hard cut at the limit.
function splitPoint(flat, start, limit) {
  const window = flat.slice(start, limit);
  const min = window.length / 2;
  let i = Math.max(window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(', '));
  if (i >= min) return start + i + 1;
  i = window.lastIndexOf(' ');
  return i >= min ? start + i : limit;
}

function upperBound(arr, value, key = (x) => x) {
  // index of the last element whose key <= value, or -1
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= value) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const pageOfOffset = (offset) => Math.max(0, upperBound(doc.pageStarts, offset));
const sentenceAt = (offset) => upperBound(doc.sentences, offset, (s) => s.start);

// Map a DOM position inside a text-layer span to an offset in doc.text.
function offsetFromDom(node, offset) {
  if (!node) return -1;
  const span = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const info = doc.divInfo.get(span);
  if (!info) return -1;
  const pg = doc.pages[info.page];
  const local = node.nodeType === Node.TEXT_NODE ? offset : 0;
  return pg.itemStarts[info.item] + Math.min(local, pg.itemStrs[info.item].length);
}

function offsetFromPoint(x, y) {
  let node = null, offset = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  }
  if (!node) return -1;
  // Only count it when the pointer is actually over the text, not empty space beside it.
  const span = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!doc.divInfo.get(span)) return -1;
  const rect = span.getBoundingClientRect();
  if (x < rect.left - 2 || x > rect.right + 2 || y < rect.top - 2 || y > rect.bottom + 2) return -1;
  return offsetFromDom(node, offset);
}

const WORD_CHAR = /[\p{L}\p{N}'’\-]/u;

// The word containing (or, on a space, following) an offset: { start, end }.
function wordAt(pos) {
  const t = doc.text;
  let start = pos;
  while (start < t.length && !WORD_CHAR.test(t[start]) && !WORD_CHAR.test(t[start - 1] ?? '')) start++;
  while (start > 0 && WORD_CHAR.test(t[start - 1])) start--;
  let end = start;
  while (end < t.length && WORD_CHAR.test(t[end])) end++;
  return end > start ? { start, end } : null;
}

// Sentence index for a start offset (an offset between sentences belongs to the next one).
function sentenceForStart(pos) {
  let idx = Math.max(0, sentenceAt(pos));
  if (doc.sentences[idx] && pos >= doc.sentences[idx].end) idx++;
  return idx < doc.sentences.length ? idx : -1;
}

function rangesForSpan(span) {
  if (!span) return [];
  const ranges = [];
  const p0 = pageOfOffset(span.start), p1 = pageOfOffset(span.end - 1);
  for (let p = p0; p <= p1; p++) {
    const pg = doc.pages[p];
    if (!pg?.textDivs) continue;
    for (let i = 0; i < pg.itemStarts.length; i++) {
      const a = pg.itemStarts[i], b = a + pg.itemStrs[i].length;
      if (b <= span.start) continue;
      if (a >= span.end) break;
      const node = pg.textDivs[i]?.firstChild;
      if (!node || !node.isConnected) continue;
      const r = new Range();
      r.setStart(node, Math.max(0, span.start - a));
      r.setEnd(node, Math.min(node.length, span.end - a));
      ranges.push(r);
    }
  }
  return ranges;
}

// ---------------------------------------------------------------- highlights

const marks = { startmark: null, playing: null }; // each: { start, end } in doc.text, or null

function setMark(name, span) {
  marks[name] = span;
  if (!hasHighlights) return;
  if (!span) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(...rangesForSpan(span)));
}

function refreshHighlights() {
  setMark('startmark', marks.startmark);
  setMark('playing', marks.playing);
}

function clearHighlights() {
  setMark('startmark', null);
  setMark('playing', null);
}

async function showPlaying(span) {
  const p0 = pageOfOffset(span.start), p1 = pageOfOffset(span.end - 1);
  for (let p = p0; p <= p1; p++) await renderPage(doc.pages[p]);
  setMark('playing', span);
  if (els.follow.checked) scrollSpanIntoView(span);
}

function scrollSpanIntoView(span) {
  const ranges = rangesForSpan(span);
  const viewRect = els.viewer.getBoundingClientRect();
  if (!ranges.length) {
    autoScrollUntil = performance.now() + 1500;
    doc.pages[pageOfOffset(span.start)]?.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const r = ranges[0].getBoundingClientRect();
  const margin = viewRect.height * 0.2;
  if (r.top < viewRect.top + margin || r.bottom > viewRect.bottom - margin) {
    autoScrollUntil = performance.now() + 1500;
    els.viewer.scrollBy({ top: r.top - viewRect.top - viewRect.height * 0.35, behavior: 'smooth' });
  }
}

let autoScrollUntil = 0; // scroll events before this time come from Follow, not the user

// ---------------------------------------------------------------- page rendering

function fitWidth() {
  return Math.max(300, els.viewer.clientWidth - 48);
}

function sizePage(pg, width) {
  const scale = Math.min(2.5, width / pg.base.width);
  pg.viewport = pg.page.getViewport({ scale });
  pg.el.style.width = `${Math.floor(pg.viewport.width)}px`;
  pg.el.style.height = `${Math.floor(pg.viewport.height)}px`;
  pg.el.style.setProperty('--total-scale-factor', String(scale));
}

function onIntersect(entries) {
  for (const entry of entries) {
    const pg = doc.pages[Number(entry.target.dataset.index)];
    if (!pg) continue;
    if (entry.isIntersecting) renderPage(pg);
    else if (!isNeededForPlayback(pg)) unrenderPage(pg);
  }
}

function isNeededForPlayback(pg) {
  return marks.playing ? pageOfOffset(marks.playing.start) === pg.index : false;
}

function renderPage(pg) {
  if (!pg) return Promise.resolve();
  if (pg.rendered) return pg.renderPromise;
  pg.rendered = true;
  const gen = ++pg.gen;
  pg.renderPromise = (async () => {
    const vp = pg.viewport;
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * ratio);
    canvas.height = Math.floor(vp.height * ratio);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    const layerEl = document.createElement('div');
    layerEl.className = 'textLayer';
    pg.el.replaceChildren(canvas, layerEl);

    await pg.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;
    if (gen !== pg.gen) return;

    const layer = new pdfjsLib.TextLayer({ textContentSource: pg.textContent, container: layerEl, viewport: vp });
    await layer.render();
    if (gen !== pg.gen) return;
    pg.textDivs = layer.textDivs;
    pg.textDivs.forEach((div, item) => doc.divInfo.set(div, { page: pg.index, item }));
    refreshHighlights();
  })().catch((err) => {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
  });
  return pg.renderPromise;
}

function unrenderPage(pg) {
  if (!pg.rendered) return;
  pg.gen++;
  pg.rendered = false;
  pg.renderPromise = null;
  pg.textDivs = null;
  pg.el.replaceChildren();
}

let resizeTimer = null;
let lastWidth = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const width = fitWidth();
    if (!doc.pages.length || Math.abs(width - lastWidth) < 20) return;
    lastWidth = width;
    // Keep the reading position: remember which page is at the top and how far into it.
    const top = els.viewer.scrollTop;
    const anchor = doc.pages.find((pg) => pg.el.offsetTop + pg.el.offsetHeight > top) || doc.pages[0];
    const frac = (top - anchor.el.offsetTop) / anchor.el.offsetHeight;
    doc.pages.forEach((pg) => { unrenderPage(pg); sizePage(pg, width); });
    autoScrollUntil = performance.now() + 500; // re-layout, not the user scrolling
    els.viewer.scrollTop = anchor.el.offsetTop + frac * anchor.el.offsetHeight;
    doc.pages.forEach((pg) => { doc.observer.unobserve(pg.el); doc.observer.observe(pg.el); });
  }, 200);
});

// ---------------------------------------------------------------- viewer interaction

function wireViewer() {
  // Scrolling by hand (wheel, trackpad, scrollbar, keys) while listening pauses Follow,
  // so the view isn't pulled back while you look for a new start point.
  els.viewer.addEventListener('scroll', () => {
    if (performance.now() < autoScrollUntil) return; // our own Follow scroll
    if (player.ctx && els.follow.checked) {
      els.follow.checked = false;
      setStatus('Follow paused while you browse. Tick Follow to jump back to the spoken text.');
    }
  }, { passive: true });

  // Click a word to read from there onward; drag-select a passage to read just that passage.
  els.viewer.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    const sel = window.getSelection();
    let pos = -1, selEnd = -1;
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      pos = offsetFromDom(r.startContainer, r.startOffset);
      selEnd = offsetFromDom(r.endContainer, r.endOffset);
    }
    if (pos < 0) pos = offsetFromPoint(e.clientX, e.clientY);
    if (pos < 0) return; // clicked empty space: keep the current marker
    const word = wordAt(pos);
    if (!word) return;
    sel?.removeAllRanges();
    // A selection covering more than one word is a passage; one word (or a click) reads onward.
    const lastWord = selEnd > word.end ? wordAt(selEnd - 1) : null;
    if (lastWord && lastWord.end > word.end) {
      setMarker({ start: word.start, end: lastWord.end, passage: true });
    } else {
      setMarker({ start: word.start, end: word.end, passage: false });
    }
  });
}

function setMarker(marker) {
  startMarker = marker;
  setMark('startmark', marker);
  const page = pageOfOffset(marker.start) + 1;
  const action = player.ctx ? 'Press Play from here' : 'Press Play or Space';
  if (marker.passage) {
    const words = doc.text.slice(marker.start, marker.end).trim().split(/\s+/).length;
    setStatus(`Passage selected (${words} words, page ${page}). ${action} to hear just this passage.`);
  } else {
    const word = doc.text.slice(marker.start, marker.end);
    setStatus(`Start marked at “${word}” (page ${page}). ${action} to read from here onward.`);
  }
  if (player.ctx) els.play.textContent = 'Play from here';
}

// { start, end, passage } chosen by the user; cleared once playback starts from it.
let startMarker = null;

function wireKeys() {
  // Buttons keep focus after a click; drop it so Space doesn't press them again.
  document.addEventListener('click', (e) => {
    if (e.target instanceof HTMLButtonElement) e.target.blur();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Space') { e.preventDefault(); onPlayButton(); }
    else if (e.code === 'Escape') player.stopPlayback(true);
    else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && player.ctx) {
      e.preventDefault();
      player.skip(e.code === 'ArrowLeft' ? -1 : 1);
    }
    else if (e.key === 'o' && e.metaKey) { e.preventDefault(); openPdf(); }
  });
}

function onPlayButton() {
  if (els.play.disabled) return;
  if (startMarker) { startFrom(startMarker.start, startMarker.passage ? startMarker.end : null); return; }
  if (player.ctx) { player.togglePause(); return; }
  // No marker: start from the first sentence on the page at the top of the view.
  const top = els.viewer.scrollTop;
  const pg = doc.pages.find((p) => p.el.offsetTop + p.el.offsetHeight > top + 40) || doc.pages[0];
  const idx = doc.sentences.findIndex((s) => s.end > doc.pageStarts[pg.index]);
  startFrom(doc.sentences[Math.max(0, idx)].start);
}

function startFrom(pos, end = null) {
  startMarker = null;
  setMark('startmark', null);
  els.follow.checked = true;
  player.start(pos, end); // must run synchronously inside the click/keypress so audio is allowed to play
}

// ---------------------------------------------------------------- playback

const player = {
  ctx: null, jobId: null, rate: 22050, baseIdx: 0, lastIdx: 0, firstStart: 0, lastEnd: 0,
  next: 0, until: 0, queue: [], ended: false, pumping: false, timer: null, current: -1,
  passage: false,

  // Read from `pos` onward, or only up to `end` when a passage was selected.
  async start(pos, end = null) {
    const idx = sentenceForStart(pos);
    if (idx < 0) return;
    pos = Math.max(pos, doc.sentences[idx].start);
    const lastIdx = end === null ? doc.sentences.length - 1 : Math.max(idx, sentenceAt(end - 1));
    const lastEnd = end === null ? doc.sentences[lastIdx].end : Math.min(end, doc.sentences[lastIdx].end);
    this.stopPlayback(false);
    this.ctx = new AudioContext(); // created inside the click handler
    const ctx = this.ctx;
    els.play.textContent = 'Pause';
    els.stop.disabled = els.back.disabled = els.next.disabled = false;
    setStatus('Preparing voice…');
    Object.assign(this, { baseIdx: idx, lastIdx, firstStart: pos, lastEnd, passage: end !== null });
    await showPlaying(this.spanFor(idx));

    // First chunk starts at the chosen word, the last ends where the passage ends.
    const sentences = [];
    for (let i = idx; i <= lastIdx; i++) {
      const sp = this.spanFor(i);
      sentences.push(doc.spoken.slice(sp.start, sp.end));
    }
    const startPage = pageOfOffset(pos) + 1;
    const res = await api().start(sentences, els.voice.value, parseFloat(els.speed.value));
    if (ctx !== this.ctx) return; // replaced by a newer click meanwhile
    if (res.error) {
      this.stopPlayback(false);
      setStatus(`Could not start: ${res.error}`, true);
      return;
    }
    Object.assign(this, { jobId: res.job, rate: res.sampleRate, next: 0,
      until: ctx.currentTime + 0.1, queue: [], ended: false, current: -1 });
    setStatus(this.passage ? `Reading the selected passage (page ${startPage}).` : `Reading from page ${startPage} onward.`);
    this.timer = setInterval(() => this.tick(), 120);
    this.pump();
  },

  // Text span spoken for sentence `idx`: the first may start mid-sentence and,
  // for a passage, the last may end mid-sentence.
  spanFor(idx) {
    const s = doc.sentences[idx];
    return {
      start: idx === this.baseIdx ? this.firstStart : s.start,
      end: idx === this.lastIdx ? this.lastEnd : s.end,
    };
  },

  async pump() {
    if (this.pumping || !this.ctx) return;
    this.pumping = true;
    const { ctx, jobId } = this;
    try {
      while (ctx === this.ctx && !this.ended && this.until - ctx.currentTime < 20) {
        const r = await api().chunk(jobId, this.next);
        if (ctx !== this.ctx || r.cancelled) return;
        if (r.error) {
          this.stopPlayback(false);
          setStatus(`Speech failed: ${r.error}`, true);
          return;
        }
        if (r.pending) break;
        if (r.end) { this.ended = true; break; }
        const sentenceIdx = this.baseIdx + this.next;
        this.next++;
        if (r.empty) continue;
        const buffer = pcmToBuffer(ctx, r.pcm, this.rate);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        const at = Math.max(this.until, ctx.currentTime + 0.05);
        src.start(at);
        this.until = at + buffer.duration;
        this.queue.push({ at, end: this.until, idx: sentenceIdx });
      }
    } finally {
      this.pumping = false;
    }
  },

  tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.pump();
    const t = ctx.currentTime;
    while (this.queue.length && this.queue[0].end <= t) this.queue.shift();
    const cur = this.queue[0];
    if (cur && cur.at <= t && cur.idx !== this.current) {
      this.current = cur.idx;
      showPlaying(this.spanFor(cur.idx));
      // Remember how far onward reading got (re-hearing a passage doesn't move it).
      if (!this.passage) api().save_position(this.spanFor(cur.idx).start);
    }
    if (this.ended && !this.queue.length) {
      const wasPassage = this.passage;
      if (!wasPassage) api().save_position(0); // read to the end: next time start at the top
      this.stopPlayback(false);
      setStatus(wasPassage ? 'Finished the passage. Select another, or click a word to read onward.' : 'Finished reading.');
    }
  },

  // Jump one sentence back (delta -1) or forward (+1). Back restarts the current sentence
  // unless it has only just begun, like a music player's previous-track button.
  skip(delta) {
    if (!this.ctx) return;
    let idx = this.current >= 0 ? this.current : this.baseIdx;
    const cur = this.queue[0];
    if (delta < 0 && cur?.idx === idx && this.ctx.currentTime - cur.at > 1.5) delta = 0;
    idx += delta;
    if (idx < (this.passage ? this.baseIdx : 0) || idx > this.lastIdx) return;
    const pos = idx === this.baseIdx ? this.firstStart : doc.sentences[idx].start;
    startFrom(pos, this.passage ? this.lastEnd : null);
  },

  togglePause() {
    if (!this.ctx) return;
    if (this.ctx.state === 'running') {
      this.ctx.suspend();
      els.play.textContent = 'Play';
      this.statusBeforePause = els.status.textContent;
      setStatus('Paused. Press Play or Space to continue, or click a word to start somewhere else.');
    } else {
      this.ctx.resume();
      els.play.textContent = 'Pause';
      if (this.statusBeforePause) setStatus(this.statusBeforePause);
    }
  },

  stopPlayback(userInitiated) {
    clearInterval(this.timer);
    this.timer = null;
    if (this.ctx) {
      this.ctx.close();
      api().cancel(); // stop generating speech nobody will hear
    }
    this.ctx = null;
    this.jobId = null;
    this.queue = [];
    this.current = -1;
    setMark('playing', null);
    els.play.textContent = 'Play';
    els.stop.disabled = els.back.disabled = els.next.disabled = true;
    if (userInitiated) setStatus('Stopped. Click a word or select a passage, then press Play.');
  },
};

function pcmToBuffer(ctx, b64, rate) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const buffer = ctx.createBuffer(1, n, rate);
  const out = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v & 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return buffer;
}
