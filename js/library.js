// library.js - the "Library" dialog: open any saved paper, or add new ones by
// arXiv ID / link / DOI (paste many at once), by title search, or from a starter set.
// Downloads run server-side (fetch_paper.py) through /api/dash/fetch; we poll /api/dash/jobs.
const $ = (id) => document.getElementById(id);
const STARTER = [
  ['1706.03762', 'Attention Is All You Need'], ['2005.14165', 'GPT-3: Few-Shot Learners'], ['1810.04805', 'BERT'],
  ['1512.03385', 'ResNet'], ['2106.09685', 'LoRA'], ['2010.11929', 'Vision Transformer (ViT)'],
  ['2103.00020', 'CLIP'], ['2203.02155', 'InstructGPT (RLHF)'], ['2302.13971', 'LLaMA'], ['2307.09288', 'Llama 2'],
  ['1409.0473', 'Bahdanau attention (NMT)'], ['1301.3781', 'word2vec'],
];

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v; else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const api = async (path, body) => {
  const r = await fetch('/api/dash/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
};

export function createLibrary({ onOpen, toast }) {
  let papers = [], current = '', tab = 'library', busy = false;
  const dlg = el('div', { id: 'libDlg' });
  document.body.append(dlg);
  const filter = el('input', { placeholder: 'Filter by title, author or ID…' });
  const list = el('div', { class: 'lib-list' });
  const ids = el('textarea', { placeholder: 'Paste arXiv IDs, links or DOIs: one or many\n\n1706.03762\nhttps://arxiv.org/abs/2005.14165\n10.48550/arXiv.1810.04805', rows: 5 });
  const go = el('button', { class: 'pbtn', onclick: () => download(ids.value) }, 'Download');
  const out = el('pre', { class: 'lib-out', hidden: true });
  const q = el('input', { placeholder: 'Search arXiv by title or keywords…' });
  const results = el('div', { class: 'lib-list' });
  const starter = el('div', { class: 'lib-chips' }, STARTER.map(([id, t]) => el('button', { class: 'chip-btn', title: id, onclick: () => download(id) }, '+ ' + t)));

  const tabBtn = (id, label) => el('button', { 'data-t': id, onclick: () => setTab(id) }, label);
  const tabs = el('div', { class: 'seg lib-tabs' }, tabBtn('library', 'My library'), tabBtn('add', 'Add papers'));
  const libPane = el('div', {}, filter, list);
  const addPane = el('div', { hidden: true },
    el('p', { class: 'lib-h' }, 'By ID, link or DOI'), ids, el('div', { class: 'lib-row' }, go, el('span', { class: 'lib-hint' }, 'DOIs work when the paper is also on arXiv. Each paper takes a few seconds (arXiv asks for a pause between requests).')), out,
    el('p', { class: 'lib-h' }, 'Search by title'), el('div', { class: 'lib-row' }, q, el('button', { class: 'pbtn ghost', onclick: () => search() }, 'Search')), results,
    el('p', { class: 'lib-h' }, 'Starter set'), starter);
  dlg.append(el('div', { class: 'lib-card' },
    el('div', { class: 'lib-top' }, el('b', {}, '📚 Library'), tabs, el('button', { class: 'lib-x', onclick: () => close(), title: 'Close (Esc)' }, '✕')),
    libPane, addPane));
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  filter.addEventListener('input', renderList);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

  function setTab(t) {
    tab = t;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    libPane.hidden = t !== 'library'; addPane.hidden = t !== 'add';
    if (t === 'add') ids.focus(); else filter.focus();
  }
  const open = (t = tab) => { dlg.classList.add('show'); setTab(t); refresh(); };
  const close = () => dlg.classList.remove('show');

  async function refresh() {
    try { papers = (await fetch('/api/library').then((r) => r.json())).papers; } catch { papers = []; }
    renderList();
    document.querySelectorAll('.libcount').forEach((n) => { n.textContent = papers.length; });
    return papers;
  }

  function renderList() {
    const f = filter.value.toLowerCase();
    const rows = papers.filter((p) => !f || `${p.title} ${(p.authors || []).join(' ')} ${p.id}`.toLowerCase().includes(f));
    list.replaceChildren(...(rows.length ? rows.map((p) => el('div', { class: 'lib-item' + (p.id === current ? ' cur' : ''), onclick: () => { close(); onOpen(p.id); } },
      el('div', { class: 'lib-t' }, p.title),
      el('div', { class: 'lib-s' }, `${(p.authors || []).slice(0, 3).join(', ')}${(p.authors || []).length > 3 ? ' et al.' : ''} · ${(p.published || '').slice(0, 4)} · arXiv:${p.id}`),
      el('div', { class: 'lib-tags' }, p.id === current ? el('span', { class: 'tg on' }, 'reading') : null, p.brief ? el('span', { class: 'tg' }, 'brief') : null,
        p.highlights.length ? el('span', { class: 'tg' }, `${p.highlights.length} highlights`) : null, p.qa.length ? el('span', { class: 'tg' }, `${p.qa.length} Q&A`) : null)))
      : [el('p', { class: 'lib-empty' }, papers.length ? 'No paper matches.' : 'No papers yet. Open the "Add papers" tab.')]));
  }

  async function download(text) {
    if (busy) return toast('A download is already running');
    if (!text.trim()) return toast('Paste an arXiv ID, link or DOI first');
    busy = true; go.disabled = true; out.hidden = false; out.textContent = 'starting…';
    try {
      await api('fetch', { ids: text });
      for (;;) {
        const j = (await api('jobs')).slice(-1)[0];
        if (!j) break;
        out.textContent = j.output || 'working… (about 3-8 seconds per paper)';
        out.scrollTop = out.scrollHeight;
        if (j.status !== 'running') {
          await refresh();
          toast(j.saved?.length ? `Added ${j.saved.length} paper(s)` : 'Nothing was added, see the message below');
          if (j.saved?.length) { ids.value = ''; if (j.saved.length === 1) { close(); onOpen(j.saved[0]); } else setTab('library'); }
          break;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (e) { out.textContent = e.message; toast(e.message); }
    busy = false; go.disabled = false;
  }

  async function search() {
    const text = q.value.trim();
    if (!text) return;
    results.replaceChildren(el('p', { class: 'lib-empty' }, 'searching arXiv…'));
    try {
      const rs = await api('search?q=' + encodeURIComponent(text));
      results.replaceChildren(...(rs.length ? rs.map((r) => el('div', { class: 'lib-item' },
        el('div', { class: 'lib-t' }, r.title), el('div', { class: 'lib-s' }, `${r.authors.slice(0, 3).join(', ')} · ${r.published.slice(0, 4)} · arXiv:${r.id}`),
        el('div', { class: 'lib-tags' }, papers.some((p) => p.id === r.id) ? el('span', { class: 'tg on' }, 'in library') : el('button', { class: 'chip-btn', onclick: () => download(r.id) }, '+ Add')))) : [el('p', { class: 'lib-empty' }, 'No results.')]));
    } catch (e) { results.replaceChildren(el('p', { class: 'lib-empty' }, e.message)); }
  }

  document.querySelectorAll('[data-lib]').forEach((b) => b.addEventListener('click', () => open(b.dataset.lib)));
  return { open, close, refresh, setCurrent(id) { current = id; renderList(); }, get papers() { return papers; } };
}
