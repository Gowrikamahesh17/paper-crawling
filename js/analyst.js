// analyst.js - the AI explainer panel + "Crawler Notes".
//
// Flow: the crawler says "I entered section X" -> we queue a job -> one request at a time
// goes to POST /api/explain (serve.py holds the Gemini key) -> the answer streams back as
// Server-Sent Events and is typed into the panel -> when the model's `KEY:` line arrives we
// find that exact phrase in the paper and send the spider to it ("pointing").
import { log } from './logger.js';
import { sectionText, findPhrase, selectionText, spansInRange } from './loader.js';

const $ = (id) => document.getElementById(id);
const MAX_CHARS = 12000;                       // server trims too; this keeps requests small
const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export function createAnalyst({ crawler }) {
  let cfg = { hasKey: false, model: '', defaultLevel: 'student', debug: false };
  let paper = null;
  let level = 'student';
  let queue = [];                              // pending jobs
  let busy = false;
  let current = null;                          // item shown in the Live tab
  const items = [];                            // every explanation (history)
  const notes = [];                            // crawler notes (metrics / models / datasets)
  let toastTimer = 0;

  // ---------------------------------------------------------------- tiny UI helpers
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function setTab(name) {
    document.querySelectorAll('.a-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.a-body').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
  }

  function download(name, text, type) {
    const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------- text + KEY parsing
  /** The part of the streamed text to show (hides the KEY: line, even half-typed). */
  function visible(raw) {
    const i = raw.search(/(^|\n)\s*KEY:/i);
    if (i >= 0) return raw.slice(0, i).trimEnd();
    return raw.replace(/\n\s*K(E(Y)?)?$/i, '');
  }
  function keyOf(raw) {
    const m = raw.match(/(?:^|\n)\s*KEY:\s*(.+)/i);
    return m ? m[1].trim().replace(/^[\s"'`*“”]+|[\s"'`*“”]+$/g, '') : '';
  }

  // ---------------------------------------------------------------- rendering
  function renderLive() {
    const box = $('tab-live');
    box.replaceChildren();
    if (!cfg.hasKey) {
      const c = el('div', 'card hint');
      c.append(el('h4', null, 'AI explainer is off'),
        el('p', null, 'No GEMINI_API_KEY found. Get a free key at aistudio.google.com/apikey, put it in .env and restart serve.py.\n\nThe spider still crawls and annotates without it.'));
      box.append(c);
    }
    if (!current) {
      if (cfg.hasKey) box.append(el('div', 'card hint', 'Waiting for the spider to land…'));
      return;
    }
    const it = current;
    const card = el('div', 'card' + (it.status === 'error' ? ' err' : ''));
    card.append(el('h4', null, `${it.kind === 'tldr' ? 'TL;DR · ' : ''}${it.title} · ${it.level}${it.cached ? ' · cached' : ''}`));
    const p = el('p', it.status === 'streaming' || it.shown < visible(it.raw).length ? 'cursor' : '');
    p.id = 'liveText';
    p.textContent = it.status === 'error' ? it.error : visible(it.raw).slice(0, it.shown) || it.note || 'reading…';
    card.append(p);
    if (it.keyPhrase && it.status === 'done') card.append(el('div', 'key', '🔑 ' + it.keyPhrase));
    box.append(card);
    queue.forEach((j) => box.append(el('div', 'card hint', 'queued: ' + j.title)));
  }

  function renderHistory() {
    const box = $('tab-history'); box.replaceChildren();
    const done = items.filter((i) => i.status === 'done').reverse();
    if (!done.length) box.append(el('p', 'card hint', 'Nothing explained yet.'));
    for (const it of done) {
      const c = el('div', 'card');
      c.append(el('h4', null, `${it.kind === 'tldr' ? 'TL;DR · ' : ''}${it.title} · ${it.level}`), el('p', null, visible(it.raw)));
      if (it.keyPhrase) c.append(el('div', 'key', '🔑 ' + it.keyPhrase));
      c.style.cursor = 'pointer';
      c.title = 'click to send the spider back to the key phrase';
      c.addEventListener('click', () => pointAtKey(it, true));
      box.append(c);
    }
  }

  function renderNotes() {
    const box = $('crawlerNotes'); box.replaceChildren();
    $('noteCount').textContent = notes.length;
    if (!notes.length) box.append(el('p', 'card hint', 'The spider logs every metric, model and dataset its feet touch.'));
    for (const n of notes.slice().reverse()) {
      const d = el('div', 'note');
      d.append(el('b', n.type, n.type), document.createTextNode(n.text));
      d.append(el('small', null, `${n.section}${n.section ? ' - ' : ''}${n.sentence}`));
      box.append(d);
    }
  }

  // ---------------------------------------------------------------- queue + streaming
  const have = (key) => items.some((i) => i.key === key) || queue.some((j) => j.key === key);

  function enqueue(job, front = false) {
    if (!cfg.hasKey || !paper) return;
    job.key = job.key || `${job.sectionId}|${level}`;
    if (have(job.key)) return;
    job.level = level;
    if (front) queue.unshift(job);
    else {
      queue.push(job);
      while (queue.length > 3) { const i = queue.findIndex((j) => j.kind === 'section'); if (i < 0) break; queue.splice(i, 1); }   // keep it fresh
    }
    pump();
  }

  async function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    try { await run(job); } catch (e) { log.error('analyst', 'run failed', String(e)); }
    busy = false;
    renderLive();
    pump();
  }

  async function run(job) {
    const text = (job.text ?? sectionText(paper, job.section, crawler.walked, MAX_CHARS)).slice(0, MAX_CHARS);
    if (text.length < 120) { log.debug('analyst', 'skip short section', job.title); return; }
    const it = { key: job.key, kind: job.kind, title: job.title, level: job.level, sectionIdx: job.section?.index ?? 999, section: job.section || null,
      raw: '', shown: 0, status: 'streaming', cached: false, note: '', keyPhrase: '', error: '' };
    items.push(it); current = it; renderLive();
    log.info('analyst', 'explain', { title: it.title, level: it.level, chars: text.length });
    try {
      const res = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperId: paper.id, title: paper.meta.title, section: job.title, text, level: job.level, kind: job.kind === 'selection' ? 'selection' : 'section' }) });
      if (!res.ok) throw new Error(`server said HTTP ${res.status}`);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {                  // one SSE event per blank line
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'meta') it.cached = ev.cached;
          else if (ev.type === 'chunk') it.raw += ev.text;
          else if (ev.type === 'status') it.note = ev.message;
          else if (ev.type === 'error') { it.status = 'error'; it.error = ev.message; }
          else if (ev.type === 'done') it.status = 'done';
        }
      }
      if (it.status === 'streaming') it.status = it.raw ? 'done' : 'error';
      if (it.status === 'error' && !it.error) it.error = 'The stream ended without an answer.';
    } catch (e) {
      it.status = 'error'; it.error = 'Could not reach the server: ' + (e.message || e);
    }
    if (it.status === 'done') {
      it.keyPhrase = keyOf(it.raw);
      renderHistory();
      if (it.keyPhrase) pointAtKey(it);
    } else {
      log.warn('analyst', 'explain failed', it.error);
    }
    await new Promise((r) => { const t = setInterval(() => { if (it.shown >= visible(it.raw).length || it.status === 'error') { clearInterval(t); r(); } }, 120); });
  }

  /** Find the KEY phrase in the paper and send the spider to it. */
  function pointAtKey(it, jump = false) {
    if (!it.keyPhrase || !paper) return;
    const spans = it.kind === 'selection' ? findPhrase(paper, it.keyPhrase, null) : findPhrase(paper, it.keyPhrase, it.section);
    if (!spans.length) { log.debug('analyst', 'KEY phrase not found in text', it.keyPhrase); return; }
    log.info('analyst', 'pointing at', { phrase: it.keyPhrase, words: spans.length });
    if (jump) crawler.reveal(spans); else crawler.pointAt(spans);
  }

  // typewriter: reveal text a few chars per tick, faster when far behind
  setInterval(() => {
    const it = current;
    if (!it || it.status === 'error') return;
    const target = visible(it.raw).length;
    if (it.shown < target) {
      it.shown = Math.min(target, it.shown + Math.max(2, Math.ceil((target - it.shown) / 14)));
      const p = $('liveText');
      if (p) { p.textContent = visible(it.raw).slice(0, it.shown); p.className = 'cursor'; }
      if (it.shown >= target && it.status === 'done') renderLive();
    } else if (it.status === 'done' && $('liveText')?.classList.contains('cursor')) renderLive();
  }, 30);

  // ---------------------------------------------------------------- public API
  function onSection(sec) {
    $('crawlSec').textContent = sec.title;
    if (sec.isRefs) return;
    setTimeout(() => enqueue({ kind: 'section', section: sec, sectionId: sec.id, title: sec.title }), 1500);
  }

  function setLevel(l, silent = false) {
    if (!['beginner', 'student', 'researcher'].includes(l)) return;
    level = l;
    document.querySelectorAll('#levelSeg button').forEach((b) => b.classList.toggle('on', b.dataset.level === l));
    if (!silent) toast('Explanation level: ' + l);
    if (!paper) return;
    const sec = paper.sections.find((s) => s.title === $('crawlSec').textContent) || paper.sections[0];
    if (sec) enqueue({ kind: 'section', section: sec, sectionId: sec.id, title: sec.title }, true);
  }

  function explainSelection() {
    const sel = getSelection();
    const text = selectionText(sel);
    if (text.length < 8) { toast('Select some text (or an equation) in the paper first, then press E'); return; }
    if (!cfg.hasKey) { toast('Set GEMINI_API_KEY in .env to use Explain'); return; }
    const spans = spansInRange(paper, sel.getRangeAt(0));
    const label = 'Selection: ' + (text.length > 38 ? text.slice(0, 38) + '…' : text);
    if (spans[0]) crawler.goTo(spans[0], () => crawler.biggestMarkup(spans.length <= 4 ? spans : spans.slice(0, 1)));
    enqueue({ kind: 'selection', key: `sel-${hashStr(text)}|${level}`, title: label, text, sectionId: 'sel' }, true);
  }

  function exportMarkdown() {
    const done = items.filter((i) => i.status === 'done' && i.level === level);
    if (!done.length) { toast('Nothing explained yet at level "' + level + '"'); return; }
    const m = paper.meta;
    const tldr = done.find((i) => i.kind === 'tldr' || i.section?.isAbstract);
    const secs = done.filter((i) => i.kind === 'section' && i !== tldr).sort((a, b) => a.sectionIdx - b.sectionIdx);
    const picks = done.filter((i) => i.kind === 'selection');
    let md = `# Paper breakdown: ${m.title}\n\n*${(m.authors || []).join(', ')}* · arXiv:${paper.id}${m.published ? ' · ' + m.published : ''}\n\n> Explained for a **${level}** level reader with Paper Crawler (${cfg.model}).\n\n`;
    if (tldr) md += `## TL;DR\n\n${visible(tldr.raw)}\n\n`;
    md += `## Section by section\n\n`;
    for (const s of secs) md += `### ${s.title}\n\n${visible(s.raw)}\n\n${s.keyPhrase ? `> **Key:** ${s.keyPhrase}\n\n` : ''}`;
    if (picks.length) { md += `## Passages explained on request\n\n`; for (const s of picks) md += `### ${s.title}\n\n${visible(s.raw)}\n\n`; }
    const keys = [...(tldr ? [tldr] : []), ...secs].filter((s) => s.keyPhrase).map((s) => `- ${s.keyPhrase} *(${s.title})*`);
    const metrics = notes.filter((n) => n.type === 'metric').map((n) => `- **${n.text}** - ${n.sentence} *(${n.section})*`);
    md += `## Key results\n\n${[...keys, ...metrics].join('\n') || '_none captured yet_'}\n`;
    download(`${paper.id}-breakdown.md`, md, 'text/markdown');
    toast('Saved ' + paper.id + '-breakdown.md');
  }

  function exportNotes() {
    if (!notes.length) { toast('No crawler notes yet'); return; }
    download(`${paper.id}-crawler-notes.json`, JSON.stringify({ paper: paper.id, title: paper.meta.title, notes }, null, 2), 'application/json');
  }

  // ---------------------------------------------------------------- wiring
  document.querySelectorAll('.a-tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  document.querySelectorAll('#levelSeg button').forEach((b) => b.addEventListener('click', () => setLevel(b.dataset.level)));
  document.querySelectorAll('#notesSeg button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#notesSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('myNotes').hidden = b.dataset.n !== 'mine'; $('crawlerNotes').hidden = b.dataset.n !== 'crawler';
  }));
  $('btnExplain').addEventListener('click', explainSelection);
  $('btnMd').addEventListener('click', exportMarkdown);
  $('btnJson').addEventListener('click', exportNotes);
  crawler.on('section', onSection);
  crawler.on('note', (n) => { notes.push({ ...n, at: new Date().toISOString() }); renderNotes(); });

  return {
    async init() {
      try { cfg = { ...cfg, ...(await (await fetch('/api/config')).json()) }; } catch (e) { log.warn('analyst', 'no /api/config', String(e)); }
      level = cfg.defaultLevel || 'student';
      setLevel(level, true);
      renderLive(); renderHistory(); renderNotes();
      return cfg;
    },
    /** New paper loaded: reset, then explain the abstract right away as the TL;DR. */
    setPaper(p) {
      paper = p; queue = []; items.length = 0; notes.length = 0; current = null;
      $('crawlSec').textContent = '…';
      renderLive(); renderHistory(); renderNotes();
      const abs = p.sections.find((s) => s.isAbstract) || p.sections[0];
      if (abs) enqueue({ kind: 'tldr', section: abs, sectionId: abs.id, title: abs.title }, true);
    },
    setLevel, explainSelection, toast, setTab, visible, get level() { return level; },
    get items() { return items; }, get notes() { return notes; },
    get config() { return cfg; },
  };
}
