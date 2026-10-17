// loader.js - get a paper from papers/ onto the page and make it "walkable".
//
//  1. fetch papers/{id}.html (+ .json), parse it off-DOM, keep just the article
//  2. detect sections from the headings (each section = heading -> next heading)
//  3. lazily wrap every word in <span class="w"> (the spider's footholds),
//     only for blocks near the viewport (IntersectionObserver) - papers are long
//  4. helpers the other modules use: section text, phrase finding, selection spans
import { log } from './logger.js';

// Title overlay caption (toggle with T). Change it here.
export const TITLE_OVERLAY_TEXT = 'I built a spider that reads ML papers for me';

// Blocks whose text we wrap. Math / code / figures are never wrapped (SKIP).
const BLOCK_SEL = 'p, li, td, th, caption, figcaption, dt, dd, blockquote, h1, h2, h3, h4, h5, h6, ' +
  '.ltx_p, .ltx_title, .ltx_bibblock, .ltx_caption, .ltx_tag';
const SKIP = 'math, code, pre, script, style, svg, img, textarea, button, select, .w, .ltx_listing, .ltx_verbatim';
const SECTION_HEAD = '[class*="ltx_title_section"], [class*="ltx_title_subsection"], [class*="ltx_title_abstract"], ' +
  '[class*="ltx_title_bibliography"], [class*="ltx_title_appendix"], [class*="ltx_title_acknowledgements"]';

let observer = null;

export async function listPapers() {
  const r = await fetch('/api/papers');
  if (!r.ok) throw new Error('papers list failed: ' + r.status);
  return r.json();
}

// ---------------------------------------------------------------- word wrapping
/** Wrap every word of every eligible text node inside `el` in <span class="w">. */
export function wrapBlock(el) {
  if (el.__wrapped) return;
  el.__wrapped = true;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
      const p = n.parentElement;
      return p && !p.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of n.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { frag.append(part); continue; }
      const s = document.createElement('span');
      s.className = 'w';
      s.textContent = part;
      frag.append(s);
    }
    n.replaceWith(frag);
  }
}

function startLazyWrapping(root) {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      wrapBlock(e.target);
      observer.unobserve(e.target);
    }
  }, { rootMargin: '1800px 0px' });          // wrap well before the spider/scroll gets there
  root.querySelectorAll(BLOCK_SEL).forEach((b) => observer.observe(b));
}

// ---------------------------------------------------------------- sections
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Sections = headings; each runs from its heading to the next heading. */
function detectSections(root, meta) {
  let heads = [...root.querySelectorAll(SECTION_HEAD)].filter((h) => !h.closest('figure, table, .ltx_figure, .ltx_table'));
  if (heads.length < 2) heads = [...root.querySelectorAll('h1, h2, h3')];          // non-LaTeXML fallback
  heads = heads.filter((h) => clean(h.textContent));
  const sections = heads.map((h, i) => {
    const title = clean(h.textContent);
    return {
      id: `${i}-${slug(title)}`, index: i, title,
      level: /ltx_title_subsection/.test(h.className) || (!/ltx_title/.test(h.className) && h.tagName === 'H3') ? 3 : 2,
      heading: h, next: heads[i + 1] || null,
      isRefs: /^(\d+\s*)?(references|bibliography)\b/i.test(title) || /bibliography/.test(h.className),
      isAbstract: /abstract/i.test(title), top: 0, textOverride: null,
    };
  });
  if (!sections.some((s) => s.isAbstract) && meta.abstract) {                    // synthetic abstract
    sections.unshift({ id: '-abstract', index: -1, title: 'Abstract', level: 2, heading: null, next: heads[0] || null,
      isRefs: false, isAbstract: true, top: 0, textOverride: meta.abstract });
    sections.forEach((s, i) => { s.index = i; s.id = `${i}-${slug(s.title)}`; });
  }
  return sections;
}

function sectionRange(paper, sec) {
  const r = document.createRange();
  if (sec.heading) r.setStartAfter(sec.heading); else r.setStart(paper.root, 0);
  if (sec.next) r.setEndBefore(sec.next); else r.setEnd(paper.root, paper.root.childNodes.length);
  return r;
}

/** Refresh each section's document-Y (reads layout; call occasionally, never per frame). */
export function measureSections(paper) {
  const y = window.scrollY;
  for (const s of paper.sections) {
    if (s.heading) s.top = s.heading.getBoundingClientRect().top + y;
    else s.top = 0;
  }
}

/** Wrap all blocks inside a section right now (used before searching it for a phrase). */
export function ensureSectionWrapped(paper, sec) {
  const r = sectionRange(paper, sec);
  paper.root.querySelectorAll(BLOCK_SEL).forEach((b) => { if (!b.__wrapped && r.intersectsNode(b)) wrapBlock(b); });
  return r;
}

/** Wrap every block in the paper (one-time ~100ms; needed to search the whole paper). Returns null. */
export function wrapAll(paper) {
  if (!paper.allWrapped) { paper.root.querySelectorAll(BLOCK_SEL).forEach((b) => wrapBlock(b)); paper.allWrapped = true; }
  return null;
}

/** Section text for the AI, trimmed to maxChars, paragraphs the spider walked over first. */
export function sectionText(paper, sec, walked = new Set(), maxChars = 12000) {
  if (sec.textOverride) return sec.textOverride.slice(0, maxChars);
  const r = sectionRange(paper, sec);
  const blocks = [...paper.root.querySelectorAll('p, li, .ltx_p, figcaption')]
    .filter((b) => r.intersectsNode(b) && !b.parentElement.closest('p, li, .ltx_p'));
  if (!blocks.length) return clean(r.toString()).slice(0, maxChars);
  const first = blocks.filter((b) => walked.has(b));
  const rest = blocks.filter((b) => !walked.has(b));
  let out = '', used = 0;
  for (const b of [...first, ...rest]) {
    const t = clean(b.textContent);
    if (!t) continue;
    if (used + t.length > maxChars) { out += t.slice(0, Math.max(0, maxChars - used)); break; }
    out += t + '\n\n'; used += t.length + 2;
  }
  return out.trim();
}

// ---------------------------------------------------------------- phrase / selection helpers
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}%+]+/gu, '');

/** Find an exact phrase (e.g. the AI's KEY:) in a section; returns the .w spans or []. */
export function findPhrase(paper, phrase, sec, exact = false) {
  const toks = phrase.split(/\s+/).map(norm).filter(Boolean);
  if (!toks.length) return [];
  const r = sec ? ensureSectionWrapped(paper, sec) : wrapAll(paper);
  const spans = [...paper.root.querySelectorAll('.w')].filter((s) => !r || r.intersectsNode(s))
    .map((el) => ({ el, n: norm(el.textContent) })).filter((x) => x.n);
  for (let i = 0; i + toks.length <= spans.length; i++) {          // exact consecutive match
    let ok = true;
    for (let j = 0; j < toks.length && ok; j++) ok = spans[i + j].n === toks[j];
    if (ok) return spans.slice(i, i + toks.length).map((x) => x.el);
  }
  if (exact) return [];
  const longest = toks.reduce((a, b) => (b.length > a.length ? b : a), '');   // fallback: longest token
  const hit = spans.find((x) => x.n === longest) || spans.find((x) => x.n.includes(longest) && longest.length > 3);
  return hit ? [hit.el] : [];
}

/** The text of a DOM selection, with math replaced by its LaTeX alttext. */
export function selectionText(sel) {
  if (!sel || sel.isCollapsed) return '';
  const frag = sel.getRangeAt(0).cloneContents();
  frag.querySelectorAll('math').forEach((m) => m.replaceWith(` [math: ${m.getAttribute('alttext') || m.textContent}] `));
  return clean(frag.textContent);
}

/** .w spans inside a Range. */
export function spansInRange(paper, range) {
  let host = range.commonAncestorContainer;
  if (host.nodeType !== 1) host = host.parentElement;
  const out = [];
  host.querySelectorAll('.w').forEach((s) => { if (range.intersectsNode(s)) out.push(s); });
  if (!out.length) { const w = host.closest('.w'); if (w) out.push(w); }
  return out;
}

// ---------------------------------------------------------------- load
/** Load papers/{id} into `rootEl`. Returns the paper object the rest of the app uses. */
export async function loadPaper(id, rootEl) {
  const [html, meta] = await Promise.all([
    fetch(`papers/${id}.html`).then((r) => { if (!r.ok) throw new Error(`papers/${id}.html: HTTP ${r.status}`); return r.text(); }),
    fetch(`papers/${id}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const article = doc.querySelector('article.ltx_document, .ltx_page_content, article, main') || doc.body;

  // Clean: no scripts/styles/nav, no event handlers, no TeX annotations (we want MathML only).
  article.querySelectorAll('script, style, link, nav, iframe, annotation, annotation-xml, .ltx_page_logo, .ltx_pagination, .ltx_page_footer')
    .forEach((n) => n.remove());
  article.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) if (a.name.startsWith('on')) n.removeAttribute(a.name);
  });

  rootEl.replaceChildren(document.importNode(article, true));
  const root = rootEl;
  const paper = { id, meta: { title: id, authors: [], ...meta }, root, sections: [] };
  paper.sections = detectSections(root, paper.meta);
  startLazyWrapping(root);
  window.scrollTo(0, 0);
  measureSections(paper);
  log.info('loader', `loaded ${id}`, { sections: paper.sections.map((s) => s.title), kb: Math.round(html.length / 1024) });
  return paper;
}

export function setHeader(paper) {
  const m = paper.meta;
  document.getElementById('pTitle').textContent = m.title || paper.id;
  document.getElementById('pAuthors').textContent = (m.authors || []).join(', ');
  document.getElementById('pId').textContent = `arXiv:${paper.id}${m.published ? ' · ' + m.published : ''}`;
  document.title = `Paper Crawler - ${m.title || paper.id}`;
}

export function toggleTitleOverlay() {
  const el = document.getElementById('titleOverlay');
  el.textContent = TITLE_OVERLAY_TEXT;
  el.classList.toggle('show');
}
