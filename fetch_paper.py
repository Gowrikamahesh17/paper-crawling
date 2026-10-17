#!/usr/bin/env python3
"""Download an arXiv paper as HTML (+ metadata) into papers/.

    python fetch_paper.py                      # Attention Is All You Need (1706.03762)
    python fetch_paper.py 2005.14165
    python fetch_paper.py https://arxiv.org/abs/1810.04805
    python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805"

How it works
  1. Metadata (title, authors, date, abstract) comes from the arXiv API (Atom XML).
  2. The paper body is HTML: arxiv.org/html/{id} first (native, ~late-2023 onward),
     then ar5iv (covers older papers). Neither? We say so and exit non-zero.
  3. Relative image/CSS URLs are rewritten to absolute ones so figures still load.
  4. Saved as papers/{id}.html + papers/{id}.json. We download first because
     browsers cannot fetch arXiv directly (CORS).
Etiquette: descriptive User-Agent and >= ARXIV_DELAY seconds between requests.
Standard library only."""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import urljoin

import config
import logger

log = logger.get("fetch")
S = config.S
PAPERS_DIR = config.ROOT / "papers"
DEFAULT_ID = "1706.03762"
USER_AGENT = f"PaperCrawler/1.0 (educational ML-paper reader; contact: {S.arxiv_contact})"
ATOM = "{http://www.w3.org/2005/Atom}"
HTML_SOURCES = [
    ("arxiv.org/html", "https://arxiv.org/html/{id}"),
    ("ar5iv", "https://ar5iv.labs.arxiv.org/html/{id}"),
]

_last_request = 0.0


def polite_get(url, timeout=60):
    """GET with our User-Agent, waiting so requests are >= ARXIV_DELAY apart."""
    global _last_request
    wait = S.arxiv_delay - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    _last_request = time.time()
    log.info("GET %s", url)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req, timeout=timeout)


DOI_RE = re.compile(r"10\.\d{4,9}/[^\s]+", re.I)


def resolve_doi(doi):
    """Non-arXiv DOI -> arXiv ID via the free Semantic Scholar API (only papers that also live on arXiv work)."""
    doi = doi.rstrip(".,;)")
    try:
        with polite_get(f"https://api.semanticscholar.org/graph/v1/paper/DOI:{quote(doi, safe='/')}?fields=externalIds,title") as r:
            ext = json.loads(r.read()).get("externalIds") or {}
    except urllib.error.HTTPError as e:
        raise ValueError(f"DOI {doi}: not found ({e.code}). Try searching its title instead.")
    if not ext.get("ArXiv"):
        raise ValueError(f"DOI {doi} has no arXiv version, so there is no HTML to read. Search its title or add the arXiv ID.")
    return ext["ArXiv"]


STOP = {"a", "an", "the", "of", "for", "and", "in", "on", "to", "with", "by", "is", "are", "at", "via", "from"}


def search_arxiv(query, n=8):
    """Title/keyword search on the arXiv API -> [{id, title, authors, published}].
    Tries title-only matching first (precise), then falls back to all fields."""
    terms = [t for t in re.findall(r"[\w\-]+", query) if t.lower() not in STOP][:8]
    if not terms:
        return []
    for field in ("ti", "all"):
        q = "+AND+".join(f"{field}:{quote(t)}" for t in terms)
        with polite_get(f"http://export.arxiv.org/api/query?search_query={q}&max_results={n}&sortBy=relevance") as r:
            root = ET.fromstring(r.read())
        out = []
        for e in root.findall(ATOM + "entry"):
            try:
                pid = parse_id(e.findtext(ATOM + "id") or "")
            except ValueError:
                continue
            out.append({"id": pid, "title": re.sub(r"\s+", " ", e.findtext(ATOM + "title") or "").strip(),
                        "authors": [re.sub(r"\s+", " ", a.findtext(ATOM + "name") or "") for a in e.findall(ATOM + "author")][:4],
                        "published": (e.findtext(ATOM + "published") or "")[:10]})
        if out:
            return out
    return []


def parse_id(arg):
    """Accept '1706.03762', 'v5' forms, abs/pdf/html URLs, '10.48550/arXiv.1706.03762',
    other DOIs (resolved via Semantic Scholar), or old-style 'hep-th/9901001'."""
    arg = arg.strip()
    if "arxiv" not in arg.lower() and DOI_RE.search(arg):
        return parse_id(resolve_doi(DOI_RE.search(arg).group(0)))
    m = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", arg) or re.search(r"([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", arg)
    if not m:
        raise ValueError(f"Cannot find an arXiv ID in {arg!r}")
    return m.group(1)


def fetch_metadata(pid):
    with polite_get(f"http://export.arxiv.org/api/query?id_list={pid}") as r:
        root = ET.fromstring(r.read())
    entry = root.find(ATOM + "entry")
    if entry is None or (entry.findtext(ATOM + "title") or "").strip().lower() == "error":
        raise RuntimeError(f"arXiv has no paper with id {pid}")
    clean = lambda s: re.sub(r"\s+", " ", s or "").strip()
    return {
        "id": pid,
        "title": clean(entry.findtext(ATOM + "title")),
        "authors": [clean(a.findtext(ATOM + "name")) for a in entry.findall(ATOM + "author")],
        "published": clean(entry.findtext(ATOM + "published"))[:10],
        "abstract": clean(entry.findtext(ATOM + "summary")),
        "abs_url": f"https://arxiv.org/abs/{pid}",
    }


_URL_ATTR = re.compile(r"""(\b(?:src|href|poster|data-src)\s*=\s*)(["'])(.*?)\2""", re.I | re.S)


def absolutize(html, final_url):
    """Rewrite relative src/href values to absolute URLs (figures + CSS keep loading)."""
    base = final_url if final_url.endswith("/") else final_url + "/"
    m = re.search(r"""<base\s[^>]*href\s*=\s*["']([^"']+)["']""", html, re.I)
    if m:
        base = urljoin(final_url, m.group(1))
        html = html.replace(m.group(0), "")        # <base> would confuse the in-browser copy

    def fix(match):
        pre, q, val = match.groups()
        v = val.strip()
        if not v or v.startswith(("#", "data:", "http://", "https://", "mailto:", "javascript:")):
            return match.group(0)
        if v.startswith("//"):
            v = "https:" + v
        else:
            v = urljoin(base, v)
        return f"{pre}{q}{v}{q}"

    return _URL_ATTR.sub(fix, html)


def fetch_html(pid):
    """Try each HTML source in order. Returns (html, source_name, final_url)."""
    for name, tmpl in HTML_SOURCES:
        url = tmpl.format(id=pid)
        try:
            with polite_get(url) as r:
                body = r.read().decode("utf-8", errors="replace")
                final = r.geturl()
        except urllib.error.HTTPError as e:
            log.info("%s: HTTP %s", name, e.code)
            continue
        except urllib.error.URLError as e:
            log.warning("%s: %s", name, e.reason)
            continue
        if len(body) < 5000 or "ltx_" not in body:   # error page or not a LaTeXML render
            log.info("%s: response does not look like a paper (%d bytes)", name, len(body))
            continue
        # A bad conversion (e.g. a PDF-page stub for an old paper) has almost no real text: try the next source.
        visible = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(script|style|math)\b.*?</\1>", " ", body)))
        if len(visible) < 8000:
            log.info("%s: only %d chars of text, looks like a failed conversion", name, len(visible))
            print(f"  {name}: conversion looks incomplete ({len(visible)} chars of text), trying the next source...")
            continue
        return body, name, final
    return None, None, None


def fetch_one(arg, force=False):
    pid = parse_id(arg)
    safe = pid.replace("/", "_")
    html_path, json_path = PAPERS_DIR / f"{safe}.html", PAPERS_DIR / f"{safe}.json"
    if html_path.exists() and json_path.exists() and not force:
        print(f"= {pid}: already downloaded (use --force to refetch)")
        return True
    PAPERS_DIR.mkdir(exist_ok=True)
    print(f"> {pid}: fetching metadata...")
    meta = fetch_metadata(pid)
    print(f"  {meta['title']}  ({', '.join(meta['authors'][:3])}{' et al.' if len(meta['authors']) > 3 else ''})")
    html, source, final_url = fetch_html(pid)
    if html is None:
        print(f"x {pid}: this paper has no HTML version on arxiv.org/html or ar5iv. "
              "Try another paper (older and newer papers are usually covered).", file=sys.stderr)
        return False
    html_path.write_text(absolutize(html, final_url), encoding="utf-8")
    meta.update(id=safe, source=source, html_url=final_url,
                fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    json_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"+ saved {html_path.relative_to(config.ROOT)} ({len(html) // 1024} KB, via {source})")
    return True


def main():
    ap = argparse.ArgumentParser(description="Download arXiv papers as HTML for Paper Crawler.")
    ap.add_argument("paper", nargs="?", default=DEFAULT_ID, help="arXiv ID or URL (default: %(default)s)")
    ap.add_argument("--batch", metavar="IDS", help='space/comma separated list, e.g. "1706.03762 2005.14165"')
    ap.add_argument("--force", action="store_true", help="re-download even if already saved")
    args = ap.parse_args()
    ids = re.split(r"[\s,]+", args.batch.strip()) if args.batch else [args.paper]
    ok = 0
    for i in ids:
        try:
            ok += bool(fetch_one(i, args.force))
        except Exception as e:                       # keep going in batch mode
            log.error("%s failed: %s", i, e)
            print(f"x {i}: {e}", file=sys.stderr)
    print(f"done: {ok}/{len(ids)} saved")
    sys.exit(0 if ok == len(ids) else 1)


if __name__ == "__main__":
    main()
