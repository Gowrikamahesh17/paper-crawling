# Paper Crawler

A procedurally animated, inverse-kinematics spider drops onto a real arXiv paper on a silk thread, plants its feet on actual words, annotates what it touches, and a Gemini model explains each section live in a side panel. A pun on "web crawler" that actually reads the paper.

Plain JS (ES modules) + CSS in the browser, Python standard library on the back end. No npm, no build step.

## Quick start
```bash
cp .env.example .env            # then paste your free key: https://aistudio.google.com/apikey
python fetch_paper.py           # Attention Is All You Need (1706.03762)
python serve.py                 # open http://localhost:5173
```
Without a key the spider still crawls and annotates; the panel says AI is off.

## Settings (`.env`)
| key | meaning |
|---|---|
| `GEMINI_API_KEY` | your key (stays on the server, never sent to the browser) |
| `GEMINI_MODEL` | default `gemini-2.5-flash` |
| `GEMINI_MIN_INTERVAL` | seconds between calls; free tier is ~10 req/min |
| `GEMINI_THINKING_BUDGET` | 0 = thinking off (faster, saves quota) |
| `DEFAULT_LEVEL`, `MAX_INPUT_CHARS`, `HOST`, `PORT` | explainer + server |
| `LOG_LEVEL`, `DEBUG`, `DEBUG_DUMP` | logging / debug tools (below) |
| `ARXIV_CONTACT`, `ARXIV_DELAY` | User-Agent contact + politeness delay for `fetch_paper.py` |

Real environment variables override `.env`.

## Logging and debugging
- `logs/server.log`: server + fetch events (rotating). `logs/client.log`: browser events, forwarded by `js/logger.js` via `POST /api/log`.
- `debug/debug.html` (needs `DEBUG=1`): config, one-click Gemini ping, log tails, saved AI dumps.
- `DEBUG_DUMP=1` saves each prompt + response to `debug/dumps/`.
- `http://localhost:5173/?debug`: IK lines, foot targets, step-threshold circles, fps HUD, `window.__crawler`.

## Adding and switching papers (Library)
Click **📚 Library** or **＋ Add paper** under the paper title (or press `L`):
- **My library**: filter by title/author/ID and open any saved paper; tags show which ones have a brief, highlights or Q&A.
- **Add papers**: paste one or many arXiv IDs, links or DOIs (`10.48550/arXiv.…` works directly; other DOIs are resolved through Semantic Scholar when the paper is also on arXiv), search arXiv by title, or click a starter paper. Downloads run on the server and show progress.
- A paper is only added if arXiv/ar5iv has a *real* HTML version. Thin or failed conversions (some old papers) are rejected with a clear message instead of giving you an empty page.

## Thesis workflow (reader mode)
The app starts in **Reader mode**: no random markup, no auto-scroll. The spider just shadows where *you* are reading, and your scrolling triggers the section explanations. Press `X` (or the footer switch) for **Show mode**, the original crawling performance. `V` hides the spider.

- **Select text** → a floating toolbar appears: four highlight colours, **✎ Note**, **✦ Explain**, **? Ask**. Click a highlight to edit its note, change colour or delete it.
- **Brief tab**: set your thesis topic once, then *Generate brief*: problem, contribution, method, data, key results, limitations and "for my thesis", plus evidence quotes that jump to the exact sentence.
- **Ask tab**: questions answered only from the paper text, with `QUOTE:` chips you can click to find the sentence.
- **Notes tab**: all your highlights grouped by section; click one to scroll to it. "Crawler finds" holds the auto-detected metrics, models and datasets.
- **Thesis notes .md** exports one paper: BibTeX, brief, highlights with notes, Q&A and section explanations.
- **Dashboard → Thesis Library**: a comparison matrix across all papers, "generate missing briefs" in one click, and exports for **BibTeX** (`references.bib`), **CSV** (literature matrix) and **Markdown** (literature-review notes).

Your data lives in `notes/{paper}.json` and `notes/_thesis.json` (git-ignored; back it up). Briefs and answers come from Gemini reading only the paper text, so verify important claims against the paper itself.

## Mission Control dashboard
Open **http://localhost:5173/dashboard/** while `serve.py` runs. Plain HTML/CSS/JS served by the same server: no Streamlit, no framework, no CDN, nothing to install. Dark and light themes.

| page | what you can do |
|---|---|
| Overview | model, key status, request/cache/error counts, latency chart, one-click Gemini ping |
| Crawler Live | the app embedded, with spider buttons (pause, follow, re-drop, clear, intensity, level) and live telemetry |
| Explainer Lab | pick any section (or paste text), run Gemini, see latency and cache status, edit the prompt template |
| Thesis Library | comparison matrix of all papers' briefs, bulk brief generation, BibTeX / CSV / Markdown export |
| Papers | download a paper by arXiv ID/URL (runs `fetch_paper.py`), open or delete saved papers |
| Cache | read, delete or clear saved explanations |
| Logs | live-tailing server/client logs with level filter and search |
| Settings | the non-secret runtime settings read from `.env` |

The `/api/dash/*` endpoints only answer requests from localhost, since they can fetch and delete files. The edited prompt is stored in `debug/prompt.json`.

## Controls
Mouse move: spider chases. Click: sends it there. `Space` pause, `F` camera follow, `T` title overlay, `1/2/3` calm/normal/wild, `B/S/R` beginner/student/researcher, `E` explain selection, `C` clear markup, `D` re-drop, `M` toggle mouse-chase.

## How it works
**Fetching (`fetch_paper.py`)**: metadata from the arXiv Atom API, body from `arxiv.org/html/{id}` then `ar5iv`. Relative URLs are made absolute so figures load, then it saves `papers/{id}.html/.json`. Browsers can't fetch arXiv (CORS), hence download first. 3s delay + descriptive User-Agent.

**Page (`loader.js`)**: parses the saved HTML, detects sections from headings, and lazily wraps words in `<span class="w">` via IntersectionObserver (never inside math/code/figures). Those spans are the spider's footholds.

**IK (`crawler.js`)**: each leg is two bones (30px + 44px). Given hip H and target T, `d = |HT|`, the hip angle is `acos((L1²+d²−L2²)/(2·L1·d))`; the knee sits at `H + L1·dir(angle(HT) ± a)`. The sign is fixed per leg so knees never flip. Out-of-reach targets are clamped.

**Gait**: alternating tetrapod (L1,R2,L3,R4 vs the rest). A foot steps when it drifts >24px from its rest pose or is over-extended, with eased 120–180ms lift-swing-plant arcs. A group won't start while the other is mid-swing (unless urgent).

**Motion**: noise-driven wandering, speed cruising, random "reading" pauses, always drifting down the paper. The entrance is a thread drop that ends in a leg splay; the thread snaps once the spider is ~560px from its anchor.

**Feet on words**: `document.elementFromPoint` finds the nearest `.w`; the foot stores (element, offset) and rides it through scroll. If the word reflows away, it releases and re-steps. Each plant applies a persistent `.m-*` markup; metrics, model names, datasets, citations, equation numbers and claim phrases get 3x the dramatic effects.

**Frame discipline**: `update()`/`render()` only read the DOM; writes go into a queue applied once per frame in `commit()`. Everything lives in document coordinates; the camera converts to viewport.

**AI pipeline**: spider enters a section → `analyst.js` queues it (one request at a time, text prioritising walked paragraphs, ≤12k chars) → `POST /api/explain` → `serve.py` checks `cache/` or streams Gemini (`streamGenerateContent?alt=sse`) and re-emits chunks as SSE → the panel types it out → the `KEY:` phrase is located in the paper and the spider walks over to hit it with the biggest markup. The prompt is `PROMPT_TEMPLATE` at the top of `serve.py`. Cache files are `cache/{paper}_{section}_{level}.json`.

Extras: `E` explains a selection (math is sent as LaTeX), Export .md builds the paper breakdown, and the Crawler Notes tab exports JSON.

Note: `js/main.js` and `js/logger.js` are small additions beyond the requested file list (wiring/keys and client logging).

## Five papers to try
```bash
python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805 1512.03385 2106.09685"
```
1. `1706.03762` Attention Is All You Need
2. `2005.14165` GPT-3: Language Models are Few-Shot Learners
3. `1810.04805` BERT
4. `1512.03385` ResNet: Deep Residual Learning
5. `2106.09685` LoRA

(Not every paper has an HTML version; the script tells you if not.)
