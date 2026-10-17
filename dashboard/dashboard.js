import { bibtex, bibKey } from '../js/bib.js';
// Mission Control: a tiny hash-routed single page app (no framework, no dependencies).
// Each page is a function that returns {el, stop?}; `stop` cleans up timers when you leave.
const $ = (s, r = document) => r.querySelector(s);
const api = async (path, body) => {
  const r = await fetch('/api/dash/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
};
/** hyperscript helper: h('div', {class:'x', onclick}, child, 'text') */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }
const fmtUp = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const fmtKB = (b) => (b > 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B');
const ago = (t) => fmtUp(Math.max(0, Math.floor(Date.now() / 1000 - t))) + ' ago';
const icon = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; return s; };

const PAGES = [
  ['overview', 'Overview', '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'],
  ['live', 'Crawler Live', '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>'],
  ['lab', 'Explainer Lab', '<path d="M9 3h6M10 3v6L4 20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1l-6-11V3"/>'],
  ['papers', 'Papers', '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'],
  ['library', 'Thesis Library', '<path d="M4 4h5v16H4zM11 4h5v16h-5z"/><path d="M18 6l3 1-4 13-3-1z"/>'],
  ['cache', 'Cache', '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'],
  ['logs', 'Logs', '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>'],
  ['settings', 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'],
];

// ------------------------------------------------------------------ shared: SSE explain
async function streamExplain(payload, onEvent) {
  const res = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:')); buf = buf.slice(i + 2);
      if (line) onEvent(JSON.parse(line.slice(5)));
    }
  }
}
const papersList = () => fetch('/api/papers').then((r) => r.json());

// ------------------------------------------------------------------ pages
function overview() {
  const root = h('div', { class: 'grid' });
  const stats = h('div', { class: 'grid g4' });
  const chart = h('div', { class: 'spark' });
  const pingOut = h('div', { class: 'muted' }, 'Sends one tiny request to Gemini to prove the key works.');
  const logBox = h('div', { class: 'console', style: 'max-height:220px' });
  const stat = (t, v, d, cls = '') => h('div', { class: 'card stat' }, h('h3', {}, t), h('div', { class: 'v ' + cls }, v), h('div', { class: 'd' }, d));
  root.append(stats,
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h3', {}, 'Gemini latency'), h('p', { class: 'sub' }, 'Last 40 live (non-cached) explanations, in ms'), chart),
      h('div', { class: 'card' }, h('h3', {}, 'Connection test'), h('p', { class: 'sub' }, 'Health check for your API key and model'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async (e) => {
          e.target.disabled = true; pingOut.textContent = 'pinging…';
          try { const r = await api('ping'); pingOut.className = r.ok ? 'ok' : 'bad'; pingOut.textContent = r.ok ? `✓ replied "${r.reply}" in ${r.ms} ms` : '✗ ' + r.error; } catch (er) { pingOut.className = 'bad'; pingOut.textContent = er.message; }
          e.target.disabled = false; } }, 'Ping Gemini'),
        h('a', { class: 'btn ghost', href: '#live' }, 'Watch the spider')), h('div', { style: 'margin-top:14px' }, pingOut))),
    h('div', { class: 'card' }, h('h3', {}, 'Recent server log'), logBox));
  async function tick() {
    try {
      const s = await api('status');
      stats.replaceChildren(
        stat('Model', s.model, `thinking budget ${s.settings.thinkingBudget}`),
        stat('API key', s.hasKey ? 'Configured' : 'Missing', s.hasKey ? s.keyMasked : 'add GEMINI_API_KEY to .env', s.hasKey ? 'ok' : 'bad'),
        stat('Explanations', s.calls, `${s.cacheHits} cache hits · ${s.errors} errors`),
        stat('Avg latency', s.avgMs ? s.avgMs + ' ms' : '-', `uptime ${fmtUp(s.uptime)}`),
        stat('Papers', s.papers, 'in papers/'), stat('Cache', s.cacheFiles, 'saved explanations'));
      const mx = Math.max(1, ...s.latencies);
      chart.replaceChildren(...(s.latencies.length ? s.latencies : [0]).map((v) => h('i', { style: `height:${Math.max(4, v / mx * 100)}%`, title: v + ' ms' })));
      const l = await api('logs?file=server&tail=10');
      logBox.replaceChildren(...l.lines.map((x) => h('span', { class: 'l ' + (x.split(/\s+/)[1] || '') }, x)));
    } catch { /* status pill shows offline */ }
  }
  tick(); const t = setInterval(tick, 4000);
  return { el: root, stop: () => clearInterval(t) };
}

function live() {
  const iframe = h('iframe', { title: 'Paper Crawler' });
  const sel = h('select', {});
  const readout = h('dl', { class: 'kv' });
  const win = () => iframe.contentWindow;
  const key = (k) => win().dispatchEvent(new win().KeyboardEvent('keydown', { key: k }));   // reuse the app's own hotkeys
  const crawler = () => win().__crawler;
  const seg = (items, onPick) => h('div', { class: 'seg' }, items.map(([v, l]) => h('button', { 'data-v': v, onclick: (e) => { onPick(v); [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); } }, l)));
  const load = () => { iframe.src = `/?debug&paper=${encodeURIComponent(sel.value)}`; };
  papersList().then((ps) => { sel.replaceChildren(...ps.map((p) => h('option', { value: p.id }, `${p.id} - ${(p.title || '').slice(0, 30)}`))); if (ps.length) load(); });
  sel.addEventListener('change', load);
  const btn = (label, k, cls = 'ghost') => h('button', { class: 'btn sm ' + cls, onclick: () => key(k) }, label);
  const side = h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', {}, 'Paper'), h('div', { class: 'row', style: 'margin-top:8px' }, sel, h('button', { class: 'btn sm ghost', onclick: load }, 'Reload'))),
    h('div', { class: 'card' }, h('h3', {}, 'Spider controls'), h('div', { class: 'btnrow', style: 'margin-top:10px' },
      btn('⏯ Pause', ' '), btn('🎥 Follow cam', 'f'), btn('🪂 Re-drop', 'd', ''), btn('🧹 Clear markup', 'c'), btn('🏷 Title overlay', 't'), btn('🖱 Mouse chase', 'm')),
      h('p', { class: 'sub', style: 'margin:14px 0 6px' }, 'Markup intensity'), seg([['calm', 'calm'], ['normal', 'normal'], ['wild', 'wild']], (v) => crawler()?.setIntensity(v)),
      h('p', { class: 'sub', style: 'margin:14px 0 6px' }, 'Explanation level'), seg([['b', 'beginner'], ['s', 'student'], ['r', 'researcher']], key),
      h('p', { class: 'sub', style: 'margin-top:14px' }, 'Tip: select text inside the app and press E (or use the Explain button there) to make the spider run to it.')),
    h('div', { class: 'card' }, h('h3', {}, 'Live telemetry'), readout));
  function poll() {
    try {
      const s = crawler().state, n = (v) => Math.round(v);
      const rows = [['mode', s.mode], ['section', s.section || '-'], ['paused', s.paused], ['intensity', s.intensity], ['follow cam', s.follow], ['speed', n(s.body.speed) + ' px/s'],
        ['feet planted', s.legs.filter((l) => l.planted).length + '/8'], ['markups', s.markups], ['scroll', n(s.cam.y) + ' px']];
      readout.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
    } catch { readout.replaceChildren(h('dt', {}, 'status'), h('dd', {}, 'loading…')); }
  }
  const t = setInterval(poll, 500);
  return { el: h('div', { class: 'live' }, iframe, side), stop: () => clearInterval(t) };
}

function lab() {
  const paperSel = h('select', {}), secSel = h('select', { style: 'max-width:100%' });
  const levelSel = h('select', {}, ['beginner', 'student', 'researcher'].map((l) => h('option', { value: l, selected: l === 'student' }, l)));
  const text = h('textarea', { rows: 9, placeholder: 'Pick a section above, or paste any text to explain…' });
  const answer = h('div', { class: 'answer muted' }, 'Run an explanation to see it here.');
  const meta = h('div', { class: 'row', style: 'margin-top:12px' });
  const runBtn = h('button', { class: 'btn' }, '▶ Explain');
  const promptBox = h('textarea', { rows: 7 });
  let sections = [], title = '';
  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  async function loadSections() {
    secSel.replaceChildren(h('option', {}, 'loading…'));
    const id = paperSel.value;
    const [html, meta0] = await Promise.all([fetch(`/papers/${id}.html`).then((r) => r.text()), fetch(`/papers/${id}.json`).then((r) => r.json()).catch(() => ({}))]);
    title = meta0.title || id;
    const doc = new DOMParser().parseFromString(html, 'text/html'), art = doc.querySelector('article') || doc.body;
    const heads = [...art.querySelectorAll('[class*="ltx_title_section"],[class*="ltx_title_subsection"],[class*="ltx_title_abstract"]')];
    sections = heads.map((hd, i) => {
      const r = doc.createRange(); r.setStartAfter(hd);
      heads[i + 1] ? r.setEndBefore(heads[i + 1]) : r.setEndAfter(art.lastChild);
      const f = r.cloneContents(); f.querySelectorAll('math').forEach((m) => m.replaceWith(` ${m.getAttribute('alttext') || ''} `));
      return { title: clean(hd.textContent), text: clean(f.textContent) };
    }).filter((s) => s.text.length > 80);
    secSel.replaceChildren(...sections.map((s, i) => h('option', { value: i }, s.title)));
    pick();
  }
  const pick = () => { const s = sections[+secSel.value]; if (s) text.value = s.text.slice(0, 12000); };
  secSel.addEventListener('change', pick); paperSel.addEventListener('change', loadSections);
  papersList().then((ps) => { paperSel.replaceChildren(...ps.map((p) => h('option', { value: p.id }, `${p.id} - ${(p.title || '').slice(0, 40)}`))); if (ps.length) loadSections(); });

  runBtn.addEventListener('click', async () => {
    const s = sections[+secSel.value];
    if (text.value.trim().length < 30) return toast('Need at least 30 characters of text');
    runBtn.disabled = true; answer.className = 'answer'; answer.textContent = ''; meta.replaceChildren();
    const t0 = performance.now(); let first = 0, raw = '', cached = false, err = '';
    try {
      await streamExplain({ paperId: paperSel.value || 'lab', title, section: s ? s.title : 'Pasted text', text: text.value, level: levelSel.value, kind: 'section' }, (ev) => {
        if (ev.type === 'meta') cached = ev.cached;
        if (ev.type === 'chunk') { if (!first) first = performance.now() - t0; raw += ev.text; answer.textContent = raw.replace(/\n\s*KEY:.*$/is, ''); }
        if (ev.type === 'status') answer.textContent = ev.message;
        if (ev.type === 'error') err = ev.message;
      });
    } catch (e) { err = e.message; }
    if (err) { answer.className = 'answer bad'; answer.textContent = err; }
    const k = raw.match(/KEY:\s*(.+)/i);
    if (k) answer.append(h('div', {}, h('span', { class: 'keychip' }, '🔑 ' + k[1].trim())));
    meta.append(h('span', { class: 'tag ' + (err ? 'bad' : cached ? 'warn' : 'ok') }, err ? 'error' : cached ? 'from cache' : 'live'),
      h('span', { class: 'tag' }, `${Math.round(performance.now() - t0)} ms total`), first ? h('span', { class: 'tag' }, `${Math.round(first)} ms to first token`) : null, h('span', { class: 'tag' }, `${raw.length} chars`));
    runBtn.disabled = false;
  });

  async function loadPrompt() { const p = await api('prompt'); promptBox.value = p.template; }
  loadPrompt();
  const el = h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('h3', {}, 'Input'), h('p', { class: 'sub' }, 'Choose a section from a saved paper (text is editable) and a reader level.'),
      h('div', { class: 'grid', style: 'gap:12px' }, h('label', { class: 'f' }, 'Paper', paperSel), h('label', { class: 'f' }, 'Section', secSel), h('label', { class: 'f' }, 'Level', levelSel), h('label', { class: 'f' }, 'Text sent to Gemini', text), h('div', {}, runBtn))),
    h('div', { class: 'grid', style: 'align-content:start' },
      h('div', { class: 'card' }, h('h3', {}, 'Result'), answer, meta),
      h('div', { class: 'card' }, h('h3', {}, 'Prompt template'), h('p', { class: 'sub' }, 'Used by the whole app. Must keep {section}, {title} and {level}. Cached answers keep the old prompt: clear the cache to see changes.'),
        promptBox, h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn sm', onclick: async () => { try { await api('prompt', { template: promptBox.value }); toast('Prompt saved'); } catch (e) { toast(e.message); } } }, 'Save'),
          h('button', { class: 'btn sm ghost', onclick: async () => { const r = await api('prompt/reset', {}); promptBox.value = r.template; toast('Reset to default'); } }, 'Reset')))));
  return { el };
}

function papers() {
  const body = h('tbody'), out = h('pre', { style: 'display:none;margin-top:12px' });
  const idIn = h('input', { placeholder: 'arXiv IDs, links or DOIs (one or many)', style: 'flex:1;min-width:220px' });
  const force = h('input', { type: 'checkbox' });
  const go = h('button', { class: 'btn' }, 'Download');
  async function refresh() {
    const ps = await papersList();
    body.replaceChildren(...(ps.length ? ps.map((p) => h('tr', {},
      h('td', {}, h('b', {}, p.title || p.id), h('div', { class: 'muted' }, (p.authors || []).slice(0, 3).join(', ') + ((p.authors || []).length > 3 ? ' et al.' : ''))),
      h('td', {}, h('span', { class: 'tag' }, p.id)), h('td', {}, p.published || '-'),
      h('td', { style: 'text-align:right;white-space:nowrap' },
        h('a', { class: 'btn sm ghost', target: '_blank', href: `/?paper=${encodeURIComponent(p.id)}` }, 'Open'), ' ',
        h('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`Delete ${p.id} from papers/?`)) { await api('paper/delete', { id: p.id }); refresh(); } } }, 'Delete')))) : [h('tr', {}, h('td', { colspan: 4, class: 'empty' }, 'No papers yet. Download one above.'))]));
  }
  async function watchJob() {
    for (;;) {
      const js = await api('jobs'), j = js[js.length - 1];
      if (!j) return;
      out.style.display = 'block'; out.textContent = `> ${j.id}  [${j.status}]\n${j.output || 'working… (arXiv asks for ~3s between requests)'}`;
      if (j.status !== 'running') { go.disabled = false; refresh(); toast(j.status === 'done' ? 'Paper saved' : 'Download failed'); return; }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  go.addEventListener('click', async () => {
    if (!idIn.value.trim()) return toast('Enter an arXiv ID');
    go.disabled = true;
    try { await api('fetch', { id: idIn.value, force: force.checked }); watchJob(); } catch (e) { toast(e.message); go.disabled = false; }
  });
  refresh(); watchJob();
  return { el: h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', {}, 'Download a paper'), h('p', { class: 'sub' }, 'Runs fetch_paper.py on the server (arXiv HTML first, then ar5iv).'),
      h('div', { class: 'row' }, idIn, h('label', { class: 'row muted', style: 'gap:6px' }, force, 'overwrite'), go), out),
    h('div', { class: 'card' }, h('h3', {}, 'Library'), h('table', {}, h('thead', {}, h('tr', {}, ['Paper', 'ID', 'Date', ''].map((x) => h('th', {}, x)))), body))) };
}


function library() {
  const body = h('tbody'), status = h('div', { class: 'muted' });
  const topic = h('input', { placeholder: 'Thesis topic', style: 'flex:2;min-width:240px' }), rq = h('input', { placeholder: 'Research question (optional)', style: 'flex:2;min-width:240px' });
  let data = { papers: [], thesis: {} };
  const dl = (name, text, type) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); a.click(); };
  const year = (p) => (p.published || '').slice(0, 4);
  const cut = (t, n = 150) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');
  async function load() {
    data = await fetch('/api/library').then((r) => r.json());
    topic.value = data.thesis.topic || ''; rq.value = data.thesis.question || '';
    const done = data.papers.filter((p) => p.brief).length;
    status.textContent = `${data.papers.length} papers · ${done} with a brief · ${data.papers.reduce((a, p) => a + p.highlights.length, 0)} highlights · ${data.papers.reduce((a, p) => a + p.qa.length, 0)} Q&A`;
    body.replaceChildren(...(data.papers.length ? data.papers.map((p) => {
      const b = p.brief, td = (t, n) => h('td', { title: t || '', style: 'min-width:170px;max-width:240px;vertical-align:top;font-size:12.5px' }, b ? cut(t, n) : h('span', { class: 'muted' }, '-'));
      return h('tr', {},
        h('td', { style: 'min-width:200px;vertical-align:top' }, h('b', {}, p.title), h('div', { class: 'muted' }, `${(p.authors || [])[0] || ''}${(p.authors || []).length > 1 ? ' et al.' : ''} · ${year(p)}`), h('span', { class: 'tag', style: 'margin-top:4px' }, bibKey(p))),
        td(b?.problem), td(b?.method), td(b?.data_and_setup), td((b?.key_results || []).slice(0, 3).join(' • '), 220), td((b?.limitations || []).slice(0, 2).join(' • '), 200),
        h('td', { style: 'vertical-align:top;white-space:nowrap' }, h('span', { class: 'tag' }, `${p.highlights.length} hl`), ' ', h('span', { class: 'tag' }, `${p.qa.length} Q&A`)),
        h('td', { style: 'vertical-align:top;text-align:right;white-space:nowrap' }, h('a', { class: 'btn sm ghost', target: '_blank', href: `/?paper=${encodeURIComponent(p.id)}` }, 'Read')));
    }) : [h('tr', {}, h('td', { colspan: 8, class: 'empty' }, 'No papers yet. Download some on the Papers page.'))]));
  }
  const genBtn = h('button', { class: 'btn', onclick: async (e) => {
    const todo = data.papers.filter((p) => !p.brief); if (!todo.length) return toast('Every paper already has a brief');
    e.target.disabled = true;
    for (const [i, p] of todo.entries()) {
      status.textContent = `Reading ${i + 1}/${todo.length}: ${p.title}…`;
      try { const r = await fetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: p.id }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); } catch (er) { toast(`${p.id}: ${er.message}`); }
    }
    e.target.disabled = false; load();
  } }, '✦ Generate missing briefs');
  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const exportCsv = () => {
    const cols = ['id', 'title', 'authors', 'year', 'one_liner', 'problem', 'contribution', 'method', 'data_and_setup', 'key_results', 'limitations', 'relevance_to_thesis', 'keywords', 'highlights'];
    const rows = data.papers.map((p) => { const b = p.brief || {}; return [p.id, p.title, (p.authors || []).join('; '), year(p), b.one_liner, b.problem, b.contribution, b.method, b.data_and_setup, (b.key_results || []).join(' | '), (b.limitations || []).join(' | '), b.relevance_to_thesis, (b.keywords || []).join('; '), p.highlights.length]; });
    dl('literature-matrix.csv', [cols, ...rows].map((r) => r.map(csvEsc).join(',')).join('\n'), 'text/csv');
  };
  const exportReview = () => {
    let md = `# Literature notes\n\n${data.thesis.topic ? `**Thesis:** ${data.thesis.topic}\n\n` : ''}${data.thesis.question ? `**Research question:** ${data.thesis.question}\n\n` : ''}`;
    for (const p of data.papers) {
      const b = p.brief; md += `## ${p.title} (${year(p)})\n\n*${(p.authors || []).join(', ')}* · cite key \`${bibKey(p)}\` · arXiv:${p.id}\n\n`;
      if (b) md += `${b.one_liner}\n\n- **Problem:** ${b.problem}\n- **Method:** ${b.method}\n- **Data:** ${b.data_and_setup}\n- **Results:** ${(b.key_results || []).join('; ')}\n- **Limitations:** ${(b.limitations || []).join('; ')}\n- **For my thesis:** ${b.relevance_to_thesis}\n\n`;
      else md += '_No brief yet._\n\n';
      if (p.highlights.length) md += '**My highlights**\n\n' + p.highlights.map((x) => `> ${x.text}${x.note ? `\n\n*${x.note}*` : ''}\n`).join('\n') + '\n';
    }
    dl('literature-review-notes.md', md, 'text/markdown');
  };
  load();
  return { el: h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', {}, 'My thesis'), h('p', { class: 'sub' }, 'Included in every brief and answer so the AI tells you how each paper relates to your work.'),
      h('div', { class: 'row' }, topic, rq, h('button', { class: 'btn ghost', onclick: async () => { await fetch('/api/thesis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: topic.value, question: rq.value }) }); toast('Saved'); } }, 'Save'))),
    h('div', { class: 'card' }, h('div', { class: 'row sp', style: 'margin-bottom:12px' }, h('div', {}, h('h3', {}, 'Comparison matrix'), status),
      h('div', { class: 'row' }, genBtn, h('button', { class: 'btn ghost', onclick: () => dl('references.bib', data.papers.map(bibtex).join('\n\n') + '\n', 'text/plain') }, 'BibTeX'),
        h('button', { class: 'btn ghost', onclick: exportCsv }, 'CSV'), h('button', { class: 'btn ghost', onclick: exportReview }, 'Markdown'))),
      h('div', { style: 'overflow-x:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['Paper', 'Problem', 'Method', 'Data & setup', 'Key results', 'Limitations', 'Mine', ''].map((x) => h('th', {}, x)))), body)))) };
}

function cache() {
  const body = h('tbody'), view = h('pre', { style: 'display:none;margin-top:14px' });
  async function refresh() {
    const files = await api('cache');
    body.replaceChildren(...(files.length ? files.map((f) => h('tr', { style: 'cursor:pointer', onclick: () => { view.style.display = 'block'; view.textContent = `${f.name}\n\n${f.text}`; } },
      h('td', {}, h('b', {}, f.section || '-'), h('div', { class: 'muted' }, f.name)), h('td', {}, h('span', { class: 'tag' }, f.level || '-')), h('td', {}, fmtKB(f.size)), h('td', {}, ago(f.mtime)),
      h('td', { style: 'text-align:right' }, h('button', { class: 'btn sm danger', onclick: async (e) => { e.stopPropagation(); await api('cache/delete', { name: f.name }); refresh(); } }, 'Delete')))) : [h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'Cache is empty.'))]));
  }
  refresh();
  return { el: h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('div', {}, h('h3', {}, 'Cached explanations'), h('p', { class: 'sub' }, 'Each file is a saved Gemini answer. Click a row to read it. Cached sections cost no quota.')),
    h('button', { class: 'btn danger', onclick: async () => { if (confirm('Delete ALL cached explanations?')) { const r = await api('cache/delete', { all: true }); toast(`Deleted ${r.deleted} file(s)`); refresh(); } } }, 'Clear all')),
    h('table', {}, h('thead', {}, h('tr', {}, ['Section', 'Level', 'Size', 'Saved', ''].map((x) => h('th', {}, x)))), body), view) };
}

function logs() {
  let file = 'server', minLvl = 'DEBUG', timer = null;
  const ORDER = { DEBUG: 0, INFO: 1, WARNING: 2, WARN: 2, ERROR: 3 };
  const box = h('div', { class: 'console', style: 'max-height:calc(100vh - 260px);min-height:360px' });
  const search = h('input', { placeholder: 'filter…', style: 'width:200px' });
  const auto = h('input', { type: 'checkbox', checked: true });
  let last = [];
  function paint() {
    const q = search.value.toLowerCase();
    const rows = last.map((raw) => {
      let lvl = (raw.split(/\s+/)[1] || 'INFO').toUpperCase(), line = raw;
      if (file === 'client') { try { const e = JSON.parse(raw); lvl = (e.level || 'info').toUpperCase(); line = `${(e.t || '').slice(11, 19)} ${lvl.padEnd(7)} [${e.scope || ''}] ${e.msg || ''} ${e.data ? JSON.stringify(e.data) : ''}`; } catch { /* raw */ } }
      return { lvl, line };
    }).filter((r) => (ORDER[r.lvl] ?? 1) >= ORDER[minLvl] && (!q || r.line.toLowerCase().includes(q)));
    const atEnd = box.scrollTop + box.clientHeight > box.scrollHeight - 40;
    box.replaceChildren(...(rows.length ? rows.map((r) => h('span', { class: 'l ' + r.lvl }, r.line)) : [h('div', { class: 'empty' }, 'No log lines match.')]));
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
  async function load() { try { last = (await api(`logs?file=${file}&tail=500`)).lines; paint(); } catch { /* offline */ } }
  const fileSeg = h('div', { class: 'seg' }, ['server', 'client'].map((f) => h('button', { class: f === file ? 'on' : '', onclick: (e) => { file = f; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); load(); } }, f)));
  const lvlSeg = h('div', { class: 'seg' }, ['DEBUG', 'INFO', 'WARNING', 'ERROR'].map((l) => h('button', { class: l === minLvl ? 'on' : '', onclick: (e) => { minLvl = l; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); paint(); } }, l.toLowerCase())));
  search.addEventListener('input', paint);
  const start = () => { clearInterval(timer); if (auto.checked) timer = setInterval(load, 2000); };
  auto.addEventListener('change', start);
  load(); start();
  return { stop: () => clearInterval(timer), el: h('div', { class: 'card' }, h('div', { class: 'row sp', style: 'margin-bottom:12px' },
    h('div', { class: 'row' }, fileSeg, lvlSeg, search), h('div', { class: 'row' }, h('label', { class: 'row muted', style: 'gap:6px' }, auto, 'live'),
      h('button', { class: 'btn sm ghost', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([last.join('\n')])), download: file + '.log' }); a.click(); } }, 'Download'))), box) };
}

function settings() {
  const el = h('div', { class: 'grid g2' });
  api('status').then((s) => {
    const kv = (o) => h('dl', { class: 'kv' }, Object.entries(o).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
    el.append(
      h('div', { class: 'card' }, h('h3', {}, 'Runtime settings'), h('p', { class: 'sub' }, 'Read from .env when serve.py started. Edit .env and restart to change.'), kv({ model: s.model, 'api key': s.hasKey ? s.keyMasked : 'MISSING', ...s.settings })),
      h('div', { class: 'card' }, h('h3', {}, 'How to change things'), h('p', {}, 'Open the .env file in the project folder, edit a value, then stop and re-run ', h('code', {}, 'python serve.py'), '.'),
        h('p', { class: 'muted' }, 'Tip: set GEMINI_MIN_INTERVAL higher if you hit the free-tier rate limit, and DEBUG_DUMP=1 to keep every prompt/response in debug/dumps/.'),
        h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '/debug/debug.html', target: '_blank' }, 'Classic debug page'), h('a', { class: 'btn ghost', href: '/?debug', target: '_blank' }, 'App with ?debug'))));
  });
  return { el };
}

// ------------------------------------------------------------------ router + shell
const FNS = { overview, live, lab, papers, library, cache, logs, settings };
let current = null;
function route() {
  const id = (location.hash.slice(1) || 'overview'); const page = PAGES.find((p) => p[0] === id) || PAGES[0];
  current?.stop?.();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.id === page[0]));
  $('#pageTitle').textContent = page[1];
  current = FNS[page[0]]();
  $('#view').replaceChildren(current.el);
}
$('#nav').append(...PAGES.map(([id, label, svg]) => { const a = h('a', { href: '#' + id, 'data-id': id }, h('span', {}, label)); a.prepend(icon(svg)); return a; }));
addEventListener('hashchange', route);
const setTheme = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem('mc-theme', t); } catch { /* private mode */ } };
try { setTheme(localStorage.getItem('mc-theme') || 'dark'); } catch { /* ignore */ }
$('#themeBtn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
async function health() {
  const pill = $('#statusPill');
  try { const s = await api('status'); pill.className = 'pill ok'; pill.lastChild.textContent = `online · ${s.model} · ${s.hasKey ? 'key set' : 'no key'}`; }
  catch { pill.className = 'pill'; pill.lastChild.textContent = 'server offline'; }
}
health(); setInterval(health, 5000);
route();
