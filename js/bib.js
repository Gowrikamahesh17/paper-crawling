// bib.js - citation helpers (shared by the app and the dashboard). arXiv metadata -> BibTeX.
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '');

/** "Ashish Vaswani" -> "Vaswani, Ashish" (last whitespace-separated word is the surname). */
export function lastFirst(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? name : `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

export function bibKey(m) {
  const last = strip((m.authors?.[0] || 'anon').trim().split(/\s+/).pop()).toLowerCase();
  const word = (m.title || '').toLowerCase().split(/\s+/).map(strip).find((w) => w.length > 3 && !['towards', 'toward', 'using', 'with'].includes(w)) || 'paper';
  return `${last}${(m.published || '').slice(0, 4)}${word}`;
}

export function bibtex(m) {
  const id = m.arxivId || m.id;
  return `@article{${bibKey(m)},\n  title={${m.title}},\n  author={${(m.authors || []).map(lastFirst).join(' and ')}},\n` +
    `  journal={arXiv preprint arXiv:${id}},\n  year={${(m.published || '').slice(0, 4)}},\n  url={https://arxiv.org/abs/${id}}\n}`;
}
