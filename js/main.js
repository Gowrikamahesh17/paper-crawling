// main.js - wires loader + crawler + analyst together and owns the keyboard.
import { log, setLevel as setLogLevel } from './logger.js';
import { loadPaper, setHeader, toggleTitleOverlay } from './loader.js';
import { createCrawler } from './crawler.js';
import { createAnalyst } from './analyst.js';
import { createWorkspace } from './workspace.js';
import { createLibrary } from './library.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
if (DEBUG) setLogLevel('debug');

const $ = (id) => document.getElementById(id);
const crawler = createCrawler({ canvas: $('spider'), debug: DEBUG });
const analyst = createAnalyst({ crawler });
const workspace = createWorkspace({ crawler, analyst });
const library = createLibrary({ onOpen: (id) => openPaper(id), toast: (m) => analyst.toast(m) });
if (DEBUG) window.__crawler = crawler;                       // poke at it from the console

function syncIntensityUI() {
  document.querySelectorAll('#intSeg button').forEach((b) => b.classList.toggle('on', b.dataset.int === crawler.getIntensity()));
}

async function openPaper(id) {
  try { localStorage.setItem('lastPaper', id); } catch { /* private mode */ }
  const paper = await loadPaper(id, $('paper'));
  setHeader(paper);
  library.setCurrent(id);
  crawler.setPaper(paper);
  analyst.setPaper(paper);
  workspace.setPaper(paper);
  // wait a beat so the first blocks are wrapped and laid out, then lower the spider
  setTimeout(() => crawler.drop(), 500);
}

async function boot() {
  const cfg = await analyst.init();
  log.info('main', 'boot', { model: cfg.model, hasKey: cfg.hasKey, debug: DEBUG });
  crawler.start();
  const papers = await library.refresh();
  if (!papers.length) {                                      // first run: straight to "Add papers"
    $('paper').innerHTML = '<p class="boot">Your library is empty. Add a paper by arXiv ID, link or DOI.</p>';
    library.open('add');
    return;
  }
  let start = params.get('paper'); try { start = start || localStorage.getItem('lastPaper'); } catch { /* ignore */ }
  if (!papers.some((p) => p.id === start)) start = papers[0].id;
  syncIntensityUI();
  await openPaper(start);
}

// ---- reader (thesis) mode vs show mode; remembered between visits
function setMode(m) {
  crawler.setReaderMode(m === 'reader');
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('intSeg').hidden = m === 'reader';                       // intensity only matters in show mode
  try { localStorage.setItem('mode', m); } catch { /* private mode */ }
}
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); analyst.toast(b.dataset.mode === 'reader' ? 'Reader mode: calm, follows your scrolling' : 'Show mode: spider crawls and marks up'); }));
let savedMode = 'reader'; try { savedMode = localStorage.getItem('mode') || 'reader'; } catch { /* ignore */ }
setMode(savedMode);
$('btnHide').addEventListener('click', () => { const vis = crawler.toggleVisible(); $('btnHide').textContent = vis ? 'Hide spider' : 'Show spider'; });

document.querySelectorAll('#intSeg button').forEach((b) => b.addEventListener('click', () => { crawler.setIntensity(b.dataset.int); syncIntensityUI(); }));
$('btnDrop').addEventListener('click', () => crawler.drop());

// ---- keyboard
const INTENSITY_KEYS = { 1: 'calm', 2: 'normal', 3: 'wild' };
const LEVEL_KEYS = { b: 'beginner', s: 'student', r: 'researcher' };
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); analyst.toast(crawler.togglePause() ? 'Paused' : 'Resumed'); }
  else if (k === 'f') analyst.toast('Camera follow ' + (crawler.toggleFollow() ? 'on' : 'off'));
  else if (k === 't') toggleTitleOverlay();
  else if (k === 'c') { crawler.clearMarkup(); analyst.toast('Markup cleared'); }
  else if (k === 'd') crawler.drop();
  else if (k === 'e') analyst.explainSelection();
  else if (k === 'l') library.open('library');
  else if (k === 'x') setMode(crawler.readerMode ? 'show' : 'reader');
  else if (k === 'v') $('btnHide').click();
  else if (k === 'm') analyst.toast('Mouse chase ' + (crawler.toggleChase() ? 'on' : 'off'));
  else if (INTENSITY_KEYS[k]) { analyst.toast('Intensity: ' + crawler.setIntensity(INTENSITY_KEYS[k])); syncIntensityUI(); }
  else if (LEVEL_KEYS[k]) analyst.setLevel(LEVEL_KEYS[k]);
});

boot().catch((e) => { log.error('main', 'boot failed', String(e)); $('paper').textContent = 'Failed to start: ' + e.message; });
