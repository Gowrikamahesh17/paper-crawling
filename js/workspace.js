// workspace.js - the thesis workspace: your highlights + notes, the paper Brief, Ask-the-paper,
// and the thesis-notes export. Everything persists on the server (notes/{paper}.json).
//
//   selection toolbar -> highlight (4 colours) / note / explain / ask
//   Brief tab         -> POST /api/brief (whole paper -> structured JSON, evidence quotes)
//   Ask tab           -> POST /api/ask   (streams an answer + QUOTE: lines you can jump to)
import { log } from './logger.js';
import { findPhrase, spansInRange } from './loader.js';
import { bibtex } from './bib.js';

const $ = (id) => document.getElementById(id);
const COLORS = { yellow: '#fff1a0', green: '#c8f5c0', pink: '#ffd2e8', blue: '#cfe6ff' };
const SUGGESTIONS = ['What problem does this paper solve?', 'What datasets and metrics does it use?', 'What are the limitations?', 'How could I use this in my thesis?'];

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v; else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
function download(name, text, type = 'text/markdown') {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function createWorkspace({ crawler, analyst }) {
  let paper = null;
  let doc = { highlights: [], qa: [] };
  let thesis = { topic: '', question: '' };
  let brief = null;
  let saveT = 0, asking = false, briefBusy = false;
  const toast = (m) => analyst.toast(m);

  // ---------------------------------------------------------------- persistence
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => post('/api/notes', { paper: paper.id, doc: { highlights: doc.highlights, qa: doc.qa } })
      .catch((e) => log.warn('workspace', 'save failed', String(e))), 500);
  }

  // ---------------------------------------------------------------- highlights
  const sectionOf = (span) => {
    const y = span.getBoundingClientRect().top + window.scrollY + 4;
    let s = paper.sections[0];
    for (const x of paper.sections) if (x.top <= y) s = x;
    return s;
  };
  const spansOf = (id) => [...paper.root.querySelectorAll(`[data-hid="${id}"]`)];

  function paint(spans, h) {
    spans.forEach((s) => {
      s.classList.remove(...Object.keys(COLORS).map((c) => 'u-hl-' + c));
      s.classList.add('u-hl', 'u-hl-' + h.color); s.dataset.hid = h.id;
      s.classList.toggle('has-note', !!h.note);
      s.title = h.note || '';
    });
  }
  function unpaint(id) {
    spansOf(id).forEach((s) => { s.classList.remove('u-hl', 'has-note', ...Object.keys(COLORS).map((c) => 'u-hl-' + c)); delete s.dataset.hid; s.removeAttribute('title'); });
  }

  /** Re-apply saved highlights after a paper loads (matches the exact word sequence in its section). */
  function applyAll() {
    let lost = 0;
    for (const h of doc.highlights) {
      const sec = paper.sections.find((s) => s.title === h.section);
      const spans = findPhrase(paper, h.text, sec || null, true);
      if (spans.length) paint(spans, h); else { lost++; h.lost = true; }
    }
    if (lost) log.warn('workspace', `${lost} highlight(s) could not be re-located`);
  }

  function addHighlight(color, note = '') {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return null;
    const spans = spansInRange(paper, sel.getRangeAt(0));
    if (!spans.length) { toast('Select some words of the paper text'); return null; }
    const h = { id: 'h' + Date.now().toString(36), color, note, section: sectionOf(spans[0]).title,
      text: spans.map((s) => s.textContent).join(' ').slice(0, 900), created: new Date().toISOString() };
    doc.highlights.push(h); paint(spans, h);
    sel.removeAllRanges(); hideBar(); save(); renderMine();
    return h;
  }

  // ---- floating selection toolbar
  const bar = $('selbar'), pop = $('notePop');
  bar.append(...Object.entries(COLORS).map(([c, hex]) => el('button', { class: 'dot', title: 'Highlight ' + c, style: `background:${hex}`, onclick: () => addHighlight(c) })),
    el('span', { class: 'sep' }),
    el('button', { onclick: () => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); const h = addHighlight('yellow'); if (h) openPop(h, r); } }, '✎ Note'),
    el('button', { onclick: () => { analyst.explainSelection(); hideBar(); } }, '✦ Explain'),
    el('button', { onclick: () => { const t = getSelection().toString().trim(); hideBar(); askAbout(t); } }, '? Ask'));
  bar.addEventListener('mousedown', (e) => e.preventDefault());                      // keep the selection alive
  const hideBar = () => bar.classList.remove('show');
  document.addEventListener('mouseup', (e) => {
    if (!paper || e.target.closest?.('#selbar, #notePop, #analyst')) return;
    setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !paper.root.contains(sel.anchorNode) || sel.toString().trim().length < 2) return hideBar();
      const r = sel.getRangeAt(0).getBoundingClientRect();
      bar.classList.add('show');
      const w = bar.offsetWidth;
      bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
      bar.style.top = (r.top > 56 ? r.top - 46 : r.bottom + 8) + 'px';
    }, 10);
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest?.('#selbar, #notePop')) { hideBar(); closePop(); } });
  addEventListener('scroll', hideBar, { passive: true });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideBar(); closePop(); } });

  // ---- note popover (add note / change colour / delete)
  function closePop() { pop.classList.remove('show'); }
  function openPop(h, rect) {
    const ta = el('textarea', { placeholder: 'Your note (why this matters for the thesis…)' });
    ta.value = h.note || '';
    pop.replaceChildren(
      el('div', { style: 'display:flex;gap:6px;margin-bottom:8px' }, ...Object.entries(COLORS).map(([c, hex]) => el('button', {
        style: `width:20px;height:20px;border-radius:50%;padding:0;background:${hex};border:2px solid ${c === h.color ? '#19c3d6' : 'transparent'}`,
        onclick: () => { h.color = c; paint(spansOf(h.id), h); openPop(h, rect); save(); renderMine(); } }))),
      ta, el('div', { class: 'r' },
        el('button', { onclick: () => { unpaint(h.id); doc.highlights = doc.highlights.filter((x) => x !== h); save(); renderMine(); closePop(); } }, 'Delete'),
        el('button', { class: 'go', onclick: () => { h.note = ta.value.trim(); paint(spansOf(h.id), h); save(); renderMine(); closePop(); } }, 'Save')));
    pop.classList.add('show');
    pop.style.left = Math.max(8, Math.min(innerWidth - 300, rect.left)) + 'px';
    pop.style.top = Math.min(innerHeight - 190, rect.bottom + 8) + 'px';
    ta.focus();
  }
  document.addEventListener('click', (e) => {                                          // click an existing highlight to edit it
    const s = e.target.closest?.('.u-hl');
    if (!s || !paper || !getSelection().isCollapsed) return;
    const h = doc.highlights.find((x) => x.id === s.dataset.hid);
    if (h) openPop(h, s.getBoundingClientRect());
  });

  // ---------------------------------------------------------------- Notes tab ("my highlights")
  function renderMine() {
    const box = $('myNotes'); box.replaceChildren();
    if (!doc.highlights.length) { box.append(el('p', { class: 'card hint' }, 'Select text in the paper and pick a colour, or press ✎ Note. Everything is saved to notes/ on disk and survives restarts.')); return; }
    const idx = (h) => Math.max(0, paper.sections.findIndex((s) => s.title === h.section));
    let last = '';
    for (const h of doc.highlights.slice().sort((a, b) => idx(a) - idx(b) || a.created.localeCompare(b.created))) {
      if (h.section !== last) { box.append(el('h4', { style: 'margin:12px 0 2px;font:600 11px ui-monospace,monospace;color:#19c3d6' }, h.section)); last = h.section; }
      box.append(el('div', { class: 'hl-item', 'data-c': h.color, onclick: () => {
        const sp = spansOf(h.id);
        if (sp[0]) sp[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); else toast('Could not re-locate this highlight in the page');
      } }, h.text.length > 240 ? h.text.slice(0, 240) + '…' : h.text, h.note ? el('div', { class: 'nt' }, '✎ ' + h.note) : null, h.lost ? el('small', {}, '⚠ not found in the page') : null));
    }
  }

  // ---------------------------------------------------------------- Brief tab
  const evidenceChip = (claim, quote) => el('button', { class: 'chip', title: 'Show in paper', onclick: () => revealQuote(quote) }, claim, el('i', {}, '“' + quote + '”'));
  function revealQuote(q) {
    const spans = findPhrase(paper, q, null, true);
    if (!spans.length) { toast('Could not locate that quote exactly (math or formatting differs)'); return; }
    crawler.reveal(spans);
  }

  function renderBrief() {
    const box = $('tab-brief'); box.replaceChildren();
    const topic = el('input', { placeholder: 'My thesis topic, e.g. efficient transformers for low-resource translation' });
    const rq = el('input', { placeholder: 'My research question (optional)' });
    topic.value = thesis.topic || ''; rq.value = thesis.question || '';
    box.append(el('div', { class: 'card' }, el('h4', {}, 'MY THESIS'), el('div', { class: 'a-in', style: 'margin:0' }, topic, rq,
      el('button', { class: 'pbtn ghost', onclick: async () => {
        thesis = { topic: topic.value.trim(), question: rq.value.trim() };
        await post('/api/thesis', thesis); toast('Thesis topic saved. Regenerate the brief to use it.');
      } }, 'Save topic'))));
    if (!brief) {
      box.append(el('div', { class: 'card hint' }, el('p', {}, 'One pass over the whole paper: problem, method, data, results, limitations and how it relates to your thesis, with quotes you can jump to.'),
        el('button', { class: 'pbtn', style: 'margin-top:10px', disabled: briefBusy, onclick: () => makeBrief(false) }, briefBusy ? 'Reading the whole paper…' : '✦ Generate brief')));
      return;
    }
    const sec = (t, body) => [el('h5', {}, t), body];
    const ul = (a) => el('ul', {}, (a || []).map((x) => el('li', {}, x)));
    box.append(el('div', { class: 'card brief' },
      el('p', { style: 'font-weight:600;font-size:14px' }, brief.one_liner),
      sec('Problem', el('p', {}, brief.problem)), sec('Contribution', el('p', {}, brief.contribution)), sec('Method', el('p', {}, brief.method)),
      sec('Data & setup', el('p', {}, brief.data_and_setup)), sec('Key results', ul(brief.key_results)), sec('Limitations', ul(brief.limitations)),
      sec('For my thesis', el('p', {}, brief.relevance_to_thesis)),
      sec('Keywords', el('p', {}, (brief.keywords || []).join(' · '))),
      el('h5', {}, 'Evidence (click to jump)'), ...(brief.evidence || []).map((e) => evidenceChip(e.claim, e.quote)),
      el('p', { style: 'margin-top:12px;color:#6c7a89;font-size:11px' }, `generated ${(brief.generated || '').slice(0, 16).replace('T', ' ')} · ${brief.model || ''}`),
      el('button', { class: 'pbtn ghost', style: 'margin-top:8px', disabled: briefBusy, onclick: () => makeBrief(true) }, 'Regenerate')));
  }

  async function makeBrief(force) {
    if (briefBusy) return;
    if (!analyst.config.hasKey) { toast('Set GEMINI_API_KEY in .env first'); return; }
    briefBusy = true; renderBrief();
    try {
      const r = await post('/api/brief', { paperId: paper.id, force });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      brief = j.brief;
    } catch (e) { toast('Brief failed: ' + e.message); log.error('workspace', 'brief failed', String(e)); }
    briefBusy = false; renderBrief();
  }

  // ---------------------------------------------------------------- Ask tab
  const askIn = el('textarea', { placeholder: 'Ask anything about this paper…  (Ctrl/⌘+Enter to send)', rows: 3 });
  const sendBtn = el('button', { class: 'pbtn', onclick: () => ask() }, 'Ask');
  askIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); });
  const askList = el('div');

  function parseAnswer(raw) {
    const i = raw.search(/\n?\s*QUOTE:/i);
    const quotes = [...raw.matchAll(/QUOTE:\s*(.+)/gi)].map((m) => m[1].trim().replace(/^[\s"'“”`*]+|[\s"'“”`*]+$/g, '')).filter(Boolean);
    return { text: (i >= 0 ? raw.slice(0, i) : raw).trim(), quotes };
  }
  function qaCard(q) {
    const c = el('div', {}, el('div', { class: 'q-bub' }, q.q));
    const card = el('div', { class: 'card' + (q.err ? ' err' : '') }, el('p', { class: q.streaming ? 'cursor' : '' }, q.err || q.a || 'reading the paper…'));
    (q.quotes || []).forEach((t) => card.append(el('button', { class: 'chip', onclick: () => revealQuote(t) }, '“' + (t.length > 140 ? t.slice(0, 140) + '…' : t) + '”', el('i', {}, 'show in paper'))));
    c.append(card);
    return c;
  }
  function renderAsk() {
    askList.replaceChildren();
    if (!doc.qa.length) askList.append(el('div', { class: 'card hint' }, el('p', {}, 'Answers use only the paper text and come with quotes you can jump to.'),
      ...SUGGESTIONS.map((s) => el('button', { class: 'chip', onclick: () => { askIn.value = s; ask(); } }, s))));
    doc.qa.forEach((q) => askList.append(qaCard(q)));
  }
  function askAbout(text) {
    analyst.setTab('ask');
    askIn.value = text ? `Explain this passage in the context of the paper: “${text.slice(0, 600)}”` : '';
    askIn.focus();
  }

  async function ask() {
    const question = askIn.value.trim();
    if (!question || asking) return;
    if (!analyst.config.hasKey) { toast('Set GEMINI_API_KEY in .env first'); return; }
    asking = true; sendBtn.disabled = true;
    const q = { q: question, a: '', quotes: [], t: new Date().toISOString(), streaming: true };
    doc.qa.unshift(q); askIn.value = ''; renderAsk();
    const history = doc.qa.slice(1, 4).reverse().map((x) => ({ q: x.q, a: x.a }));
    let raw = '';
    try {
      const res = await post('/api/ask', { paperId: paper.id, question, history });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rd = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:')); buf = buf.slice(i + 2);
          if (!line) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'chunk') { raw += ev.text; Object.assign(q, parseAnswer(raw), { a: parseAnswer(raw).text }); renderAsk(); }
          else if (ev.type === 'error') q.err = ev.message;
        }
      }
    } catch (e) { q.err = String(e.message || e); }
    q.streaming = false;
    if (q.err) doc.qa.shift(); else { Object.assign(q, { a: parseAnswer(raw).text, quotes: parseAnswer(raw).quotes }); save(); }
    renderAsk();
    if (q.err) toast(q.err);
    asking = false; sendBtn.disabled = false;
  }

  function buildAsk() {
    const box = $('tab-ask'); box.replaceChildren(el('div', { class: 'a-in' }, askIn, el('div', { class: 'row' }, sendBtn)), askList);
  }

  // ---------------------------------------------------------------- thesis-notes export
  function exportThesisNotes() {
    const m = paper.meta, lv = analyst.level;
    let md = `# ${m.title}\n\n*${(m.authors || []).join(', ')}* · arXiv:${paper.id}${m.published ? ' · ' + m.published : ''}\n\n`;
    md += '## Citation\n\n```bibtex\n' + bibtex({ ...m, id: paper.id }) + '\n```\n\n';
    if (brief) {
      const ul = (a) => (a || []).map((x) => `- ${x}`).join('\n');
      md += `## Brief\n\n**${brief.one_liner}**\n\n**Problem.** ${brief.problem}\n\n**Contribution.** ${brief.contribution}\n\n**Method.** ${brief.method}\n\n**Data & setup.** ${brief.data_and_setup}\n\n` +
        `**Key results**\n${ul(brief.key_results)}\n\n**Limitations**\n${ul(brief.limitations)}\n\n**Relevance to my thesis.** ${brief.relevance_to_thesis}\n\n**Keywords:** ${(brief.keywords || []).join(', ')}\n\n`;
      if ((brief.evidence || []).length) md += '**Evidence**\n' + brief.evidence.map((e) => `- ${e.claim}\n  > ${e.quote}`).join('\n') + '\n\n';
    }
    if (doc.highlights.length) {
      md += '## My highlights\n\n';
      const order = paper.sections.map((s) => s.title);
      let last = '';
      for (const h of doc.highlights.slice().sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.created.localeCompare(b.created))) {
        if (h.section !== last) { md += `### ${h.section}\n\n`; last = h.section; }
        md += `> ${h.text}\n\n${h.note ? `**Note:** ${h.note}\n\n` : ''}`;
      }
    }
    if (doc.qa.length) md += '## Questions & answers\n\n' + doc.qa.slice().reverse().map((q) => `**Q:** ${q.q}\n\n${q.a}\n${(q.quotes || []).map((t) => `\n> ${t}`).join('')}\n`).join('\n') + '\n';
    const exp = analyst.items.filter((i) => i.status === 'done' && i.level === lv && i.kind !== 'selection').sort((a, b) => a.sectionIdx - b.sectionIdx);
    if (exp.length) md += `## Section explanations (${lv})\n\n` + exp.map((i) => `### ${i.title}\n\n${analyst.visible(i.raw)}\n`).join('\n');
    download(`${paper.id}-thesis-notes.md`, md);
    toast(`Saved ${paper.id}-thesis-notes.md`);
  }
  $('btnThesis').addEventListener('click', () => paper && exportThesisNotes());

  // ---------------------------------------------------------------- public
  buildAsk();
  return {
    async setPaper(p) {
      paper = p; doc = { highlights: [], qa: [] }; brief = null; asking = false; sendBtn.disabled = false;
      hideBar(); closePop(); renderMine(); renderAsk(); renderBrief();
      try {
        const [d, t] = await Promise.all([fetch('/api/notes?paper=' + encodeURIComponent(p.id)).then((r) => r.json()), fetch('/api/thesis').then((r) => r.json())]);
        doc = { highlights: d.highlights || [], qa: d.qa || [] }; brief = d.brief || null; thesis = t;
      } catch (e) { log.warn('workspace', 'could not load notes', String(e)); }
      applyAll(); renderMine(); renderAsk(); renderBrief();
    },
    askAbout,
  };
}
