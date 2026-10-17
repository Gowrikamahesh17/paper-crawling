#!/usr/bin/env python3
"""Paper Crawler server: static files + a Gemini proxy that holds the API key.

    python serve.py        ->  http://localhost:5173

Endpoints
  GET  /api/config        non-secret settings for the browser (model, hasKey, default level)
  GET  /api/papers        list of papers in papers/
  POST /api/explain       {paperId,title,section,text,level} -> Server-Sent Events stream
  POST /api/log           browser log batch -> logs/client.log
  GET  /api/debug/*       (DEBUG=1 only) log tails, saved AI dumps, Gemini ping

The AI pipeline: browser -> /api/explain -> (cache hit? replay it) else
Gemini `streamGenerateContent?alt=sse` -> re-emit each chunk to the browser -> cache the result.
Standard library only."""
import contextlib
import hashlib
import io
import json
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import config
import logger

S = config.S
ROOT = config.ROOT
CACHE_DIR = ROOT / "cache"
PAPERS_DIR = ROOT / "papers"
NOTES_DIR = ROOT / "notes"                      # your highlights, Q&A, briefs, thesis topic (persistent)
log = logger.get("server")

# ---------------------------------------------------------------- prompt (edit me)
# {section}, {title}, {level} are filled in; the section text is appended after it.
PROMPT_TEMPLATE = (
    "You are explaining the '{section}' section of the ML paper '{title}' to a {level}. "
    "In under 70 words: what this section says, why it matters, and any key number or result. "
    "Use plain English and one simple analogy if it helps. Define any jargon you use. "
    "Then output one line starting with 'KEY:' containing the single most important exact "
    "phrase or number from the section text (copied exactly as written)."
)
LEVELS = {
    "beginner": "CS freshman",
    "student": "CS student who knows basic ML",
    "researcher": "ML researcher; be precise and technical",
}

PROMPT_FILE = ROOT / "debug" / "prompt.json"        # dashboard-edited prompt survives restarts
DEFAULT_PROMPT = PROMPT_TEMPLATE
try:
    PROMPT_TEMPLATE = json.loads(PROMPT_FILE.read_text(encoding="utf-8"))["template"]
except (OSError, ValueError, KeyError):
    pass

STATS = {"started": time.time(), "calls": 0, "cache_hits": 0, "errors": 0, "latencies": []}  # for the dashboard
JOBS = []                                                # paper-fetch jobs started from the dashboard

_gem_lock = threading.Lock()     # one Gemini call at a time (free tier is tiny)
_last_call = 0.0


class ClientGone(Exception):
    """Browser closed the SSE connection."""


class GeminiError(Exception):
    def __init__(self, message, code="gemini_error"):
        super().__init__(message)
        self.code = code


def call_gemini_json(prompt, schema, max_tokens=2500):
    """Non-streaming JSON-mode call (used for the paper brief). Same lock/throttle/retry rules."""
    global _last_call
    with _gem_lock:
        wait = S.min_interval - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        for attempt in (0, 1):
            _last_call = time.time()
            try:
                with _open_gemini(prompt, stream=False, max_tokens=max_tokens, schema=schema) as r:
                    data = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                msg, retry = _explain_http_error(e)
                if e.code == 429 and attempt == 0 and retry and retry <= 30:
                    time.sleep(retry + 1)
                    continue
                raise GeminiError(msg, "rate_limit" if e.code == 429 else "gemini_error")
            except urllib.error.URLError as e:
                raise GeminiError(f"Cannot reach Gemini: {e.reason}", "network")
    cand = (data.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []))
    try:
        return json.loads(text)
    except ValueError:
        raise GeminiError("Gemini returned invalid JSON, try again.", "bad_json")


# ---------------------------------------------------------------- paper text (for brief / ask)
class _PaperText(HTMLParser):
    """Turns the saved LaTeXML HTML into plain text with '## Section' markers. Math -> [math: latex]."""
    HEAD = re.compile(r"ltx_title_(section|subsection|abstract|appendix|bibliography|acknowledgements)")
    SKIP = ("script", "style", "annotation", "annotation-xml", "nav")

    def __init__(self, in_article):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.math, self.head, self.kind = [], 0, 0, None, ""
        self.stop, self.in_article = False, in_article

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class") or ""
        if tag == "article":
            self.in_article = True
        if tag in self.SKIP:
            self.skip += 1
        elif tag == "math":
            self.math += 1
            if self.math == 1 and self.in_article and not self.stop:
                self.out.append(f" [math: {a.get('alttext', '')}] ")
        elif len(tag) == 2 and tag[0] == "h" and self.HEAD.search(cls):
            self.head, self.kind = [], cls

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag == "math":
            self.math = max(0, self.math - 1)
        elif self.head is not None and len(tag) == 2 and tag[0] == "h":
            title = " ".join("".join(self.head).split())
            self.head = None
            if "bibliography" in self.kind:
                self.stop = True                      # drop the reference list
            elif self.in_article and not self.stop:
                self.out.append("\n\n## " + title + "\n")
        elif tag in ("p", "li", "tr", "figcaption", "caption"):
            self.out.append("\n")

    def handle_data(self, d):
        if self.stop or self.skip or self.math or not self.in_article:
            return
        (self.head if self.head is not None else self.out).append(d)


_text_cache = {}


def paper_text(pid, limit=200_000):
    f = PAPERS_DIR / f"{pid}.html"
    if not f.is_file():
        raise ValueError(f"paper {pid} not found")
    key = (pid, f.stat().st_mtime)
    if key not in _text_cache:
        html = f.read_text(encoding="utf-8", errors="replace")
        p = _PaperText(in_article="<article" not in html)
        p.feed(html)
        t = re.sub(r"[ \t\r\f\v]+", " ", "".join(p.out))
        t = re.sub(r"\n\s*\n\s*\n+", "\n\n", t).strip()
        i = t.find("## Abstract")
        _text_cache[key] = t[i:] if 0 < i < 8000 else t           # drop title/author/footnote noise before the abstract
    return _text_cache[key][:limit]


def _safe_id(v):
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(v or ""))[:60]


def load_doc(pid):
    f = NOTES_DIR / f"{_safe_id(pid)}.json"
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_doc(pid, doc):
    NOTES_DIR.mkdir(exist_ok=True)
    (NOTES_DIR / f"{_safe_id(pid)}.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")


def load_thesis():
    try:
        return json.loads((NOTES_DIR / "_thesis.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"topic": "", "question": ""}


def thesis_line(t):
    if not (t.get("topic") or t.get("question")):
        return ""
    return f"The reader is writing a thesis. Topic: {t.get('topic', '')}. Research question: {t.get('question', '')}."


def paper_title(pid):
    try:
        return json.loads((PAPERS_DIR / f"{pid}.json").read_text(encoding="utf-8")).get("title", pid)
    except (OSError, ValueError):
        return pid


BRIEF_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "one_liner": {"type": "STRING"}, "problem": {"type": "STRING"}, "contribution": {"type": "STRING"},
        "method": {"type": "STRING"}, "data_and_setup": {"type": "STRING"},
        "key_results": {"type": "ARRAY", "items": {"type": "STRING"}},
        "limitations": {"type": "ARRAY", "items": {"type": "STRING"}},
        "relevance_to_thesis": {"type": "STRING"},
        "keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
        "evidence": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "claim": {"type": "STRING"}, "quote": {"type": "STRING"}}, "required": ["claim", "quote"]}},
    },
    "required": ["one_liner", "problem", "contribution", "method", "data_and_setup", "key_results", "limitations", "relevance_to_thesis", "keywords", "evidence"],
}
BRIEF_PROMPT = (
    "You are a research assistant helping a student read papers for their thesis. {thesis} "
    "Read the paper below and fill the JSON fields. Be concise, factual and specific (numbers, dataset names). "
    "Use ONLY the paper text; if something is not stated, write 'Not stated'. "
    "one_liner: one sentence. problem/contribution/method/data_and_setup: 1-3 sentences each. "
    "key_results: up to 5 short bullets with the actual numbers. limitations: up to 4 bullets (including ones the authors admit and obvious gaps). "
    "relevance_to_thesis: 2 sentences on how it could be used in the thesis, or 'No thesis topic set.' if none was given. "
    "evidence: 3 to 6 items; each 'quote' MUST be copied exactly from the paper text (max 30 words) and support its 'claim'."
)
ASK_PROMPT = (
    "You are a careful research assistant. Answer the reader's question using ONLY the paper text below. {thesis} "
    "Rules: answer in under 150 words in plain English; mention the section in square brackets, e.g. [3.2 Attention], when useful. "
    "After the answer add up to 3 lines, each starting with 'QUOTE:' followed by an exact quote (max 25 words) copied from the paper that supports the answer. "
    "If the paper does not say, reply exactly: The paper does not state this."
)


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:50] or "section"


# ---------------------------------------------------------------- Gemini
def _open_gemini(prompt, stream=True, max_tokens=None, schema=None):
    method = "streamGenerateContent?alt=sse" if stream else "generateContent"
    url = f"{S.gemini_base}/models/{S.gemini_model}:{method}"
    gen = {"temperature": S.temperature, "maxOutputTokens": max_tokens or S.max_output_tokens}
    if schema:                                    # JSON mode: Gemini must return JSON matching the schema
        gen["responseMimeType"] = "application/json"
        gen["responseSchema"] = schema
    if "2.5" in S.gemini_model:                   # thinking budget only exists on 2.5 models
        gen["thinkingConfig"] = {"thinkingBudget": S.thinking_budget}
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": gen}
    req = urllib.request.Request(
        url, json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": S.gemini_api_key},
    )
    return urllib.request.urlopen(req, timeout=90)


def _explain_http_error(e):
    """Turn a Gemini HTTPError into (message, retry_after_seconds|None)."""
    raw = e.read().decode("utf-8", "replace")
    try:
        err = json.loads(raw).get("error", {})
    except ValueError:
        err = {}
    msg = err.get("message") or raw[:200] or str(e)
    retry = None
    for d in err.get("details", []):
        if "retryDelay" in d:
            m = re.match(r"([\d.]+)s", d["retryDelay"])
            retry = float(m.group(1)) if m else None
    log.warning("Gemini HTTP %s: %s", e.code, msg[:300])
    if e.code in (400, 403) and "API key" in msg:
        msg = "Gemini rejected the API key. Check GEMINI_API_KEY in .env."
    elif e.code == 429:
        msg = "Gemini free-tier rate limit hit. " + ("Retry in %ds." % retry if retry else "Try again shortly.")
    return msg, retry


def stream_gemini(prompt, emit, max_tokens=None):
    """Call Gemini and emit(text_chunk) as it streams. Returns the full text.
    Serialised + spaced by GEMINI_MIN_INTERVAL; retries once on a short 429."""
    global _last_call
    with _gem_lock:
        wait = S.min_interval - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        for attempt in (0, 1):
            _last_call = time.time()
            try:
                resp = _open_gemini(prompt, max_tokens=max_tokens)
                break
            except urllib.error.HTTPError as e:
                msg, retry = _explain_http_error(e)
                if e.code == 429 and attempt == 0 and retry and retry <= 30:
                    emit(None, status=f"Rate limited, retrying in {int(retry) + 1}s...")
                    time.sleep(retry + 1)
                    continue
                raise GeminiError(msg, "rate_limit" if e.code == 429 else "gemini_error")
            except urllib.error.URLError as e:
                raise GeminiError(f"Cannot reach Gemini: {e.reason}", "network")
        full, finish, block = [], None, None
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:])
                except ValueError:
                    continue
                block = (ev.get("promptFeedback") or {}).get("blockReason") or block
                for cand in ev.get("candidates", []):
                    finish = cand.get("finishReason") or finish
                    for part in (cand.get("content") or {}).get("parts", []):
                        t = part.get("text")
                        if t:
                            full.append(t)
                            emit(t)
        text = "".join(full)
        if not text.strip():
            raise GeminiError(f"Gemini returned no text (block={block}, finish={finish}).", "empty")
        log.info("Gemini ok: %d chars, finish=%s", len(text), finish)
        return text


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    # quiet the default stderr access log -> our logger at DEBUG
    def log_message(self, fmt, *args):
        log.debug("%s %s", self.address_string(), fmt % args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)

    # ---- helpers
    def _json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self, limit=400_000):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            raise ValueError("bad body size")
        return json.loads(self.rfile.read(n))

    def _sse(self, obj):
        try:
            self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise ClientGone()

    @staticmethod
    def _static_allowed(p):
        parts = [x for x in p.split("/") if x]
        if not parts:
            return True
        if any(x.startswith(".") for x in parts):             # .env, .git ...
            return False
        if parts[0] in ("css", "js", "papers", "dashboard", "index.html", "favicon.ico"):
            return True
        return parts[0] == "debug" and (len(parts) < 2 or parts[1] != "dumps")

    # ---- routing
    def do_GET(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        if p.startswith("/api/dash/"):
            return self.dash(p, parse_qs(u.query), None)
        if p.startswith("/api/"):
            return self.api_get(p, parse_qs(u.query))
        if not self._static_allowed(p):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        p = urlparse(self.path).path
        try:
            if p.startswith("/api/dash/"):
                return self.dash(p, {}, self._read_json())
            if p in ("/api/notes", "/api/thesis", "/api/brief", "/api/ask"):
                if not self._local_only():
                    return self._json({"error": "local only"}, 403)
                return getattr(self, "api_" + p.rsplit("/", 1)[1])(self._read_json(3_000_000))
            if p == "/api/explain":
                return self.api_explain()
            if p == "/api/log":
                logger.client_log(self._read_json().get("entries", []))
                return self._json({"ok": True})
        except ClientGone:
            log.debug("client disconnected")
            return
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        self.send_error(404)

    def api_get(self, p, q):
        if p == "/api/config":
            return self._json({
                "model": S.gemini_model, "hasKey": bool(S.gemini_api_key),
                "defaultLevel": S.default_level, "debug": S.debug,
                "maxInputChars": S.max_input_chars, "levels": list(LEVELS),
            })
        if p == "/api/papers":
            out = []
            for h in sorted(PAPERS_DIR.glob("*.html")):
                meta = {"id": h.stem, "title": h.stem, "authors": []}
                try:
                    meta.update(json.loads(h.with_suffix(".json").read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    pass
                out.append({k: meta.get(k) for k in ("id", "title", "authors", "published")})
            return self._json(out)
        if p == "/api/notes":
            return self._json(load_doc(q.get("paper", [""])[0]))
        if p == "/api/thesis":
            return self._json(load_thesis())
        if p == "/api/library":
            out = []
            for h in sorted(PAPERS_DIR.glob("*.html")):
                meta = {"id": h.stem, "title": h.stem, "authors": []}
                try:
                    meta.update(json.loads(h.with_suffix(".json").read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    pass
                d = load_doc(h.stem)
                out.append({**{k: meta.get(k) for k in ("id", "title", "authors", "published", "abs_url")},
                            "brief": d.get("brief"), "highlights": d.get("highlights", []), "qa": d.get("qa", [])})
            return self._json({"papers": out, "thesis": load_thesis()})
        if p.startswith("/api/debug/"):
            return self.api_debug(p, q)
        self.send_error(404)

    # ---- debug (gated by DEBUG=1)
    def api_debug(self, p, q, force=False):
        if not S.debug and not force:
            return self._json({"error": "set DEBUG=1 in .env"}, 403)
        if p == "/api/debug/logs":
            name = "client" if q.get("file", ["server"])[0] == "client" else "server"
            n = min(int(q.get("tail", ["300"])[0]), 2000)
            f = logger.LOG_DIR / f"{name}.log"
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()[-n:] if f.exists() else []
            return self._json({"file": f.name, "lines": lines})
        if p == "/api/debug/dumps":
            files = sorted((x.name for x in logger.DUMP_DIR.glob("*.json")), reverse=True)
            return self._json({"enabled": S.debug_dump, "files": files[:100]})
        if p.startswith("/api/debug/dumps/"):
            f = logger.DUMP_DIR / re.sub(r"[^A-Za-z0-9._-]", "", p.rsplit("/", 1)[1])
            if f.is_file():
                return self._json(json.loads(f.read_text(encoding="utf-8")))
            return self._json({"error": "not found"}, 404)
        if p == "/api/debug/ping":              # tiny non-streaming Gemini call
            if not S.gemini_api_key:
                return self._json({"ok": False, "error": "no GEMINI_API_KEY"})
            t0 = time.time()
            try:
                with _gem_lock, _open_gemini("Reply with the single word: pong", stream=False) as r:
                    reply = json.loads(r.read())["candidates"][0]["content"]["parts"][0]["text"]
                return self._json({"ok": True, "reply": reply.strip(), "ms": int((time.time() - t0) * 1000)})
            except urllib.error.HTTPError as e:
                return self._json({"ok": False, "error": _explain_http_error(e)[0]})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)})
        self.send_error(404)

    # ---- dashboard API (/api/dash/*): local machine only, because it can delete and fetch
    def _local_only(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return self.client_address[0] in ("127.0.0.1", "::1") and host in ("localhost", "127.0.0.1", "::1")

    def dash(self, p, q, body):
        global PROMPT_TEMPLATE
        if not self._local_only():
            return self._json({"error": "dashboard is local-only"}, 403)
        route = p[len("/api/dash/"):]
        if body is None:                                           # ---- GET
            if route == "status":
                k = S.gemini_api_key
                lat = STATS["latencies"]
                return self._json({
                    "uptime": int(time.time() - STATS["started"]), "model": S.gemini_model,
                    "hasKey": bool(k), "keyMasked": (k[:4] + "…" + k[-4:]) if len(k) > 10 else ("set" if k else ""),
                    "papers": len(list(PAPERS_DIR.glob("*.html"))), "cacheFiles": len(list(CACHE_DIR.glob("*.json"))),
                    "calls": STATS["calls"], "cacheHits": STATS["cache_hits"], "errors": STATS["errors"],
                    "latencies": lat[-40:], "avgMs": int(sum(lat) / len(lat)) if lat else 0,
                    "settings": {"minInterval": S.min_interval, "temperature": S.temperature, "maxOutputTokens": S.max_output_tokens,
                                 "thinkingBudget": S.thinking_budget, "maxInputChars": S.max_input_chars, "defaultLevel": S.default_level,
                                 "logLevel": S.log_level, "debug": S.debug, "debugDump": S.debug_dump, "host": S.host, "port": S.port},
                })
            if route == "cache":
                out = []
                for f in sorted(CACHE_DIR.glob("*.json"), key=lambda x: -x.stat().st_mtime):
                    try:
                        d = json.loads(f.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        d = {}
                    out.append({"name": f.name, "size": f.stat().st_size, "mtime": int(f.stat().st_mtime),
                                "section": d.get("section"), "level": d.get("level"), "text": d.get("text", "")})
                return self._json(out)
            if route == "search":
                import fetch_paper
                try:
                    return self._json(fetch_paper.search_arxiv(q.get("q", [""])[0]))
                except Exception as e:
                    return self._json({"error": f"search failed: {e}"}, 502)
            if route == "jobs":
                return self._json(JOBS[-10:])
            if route == "prompt":
                return self._json({"template": PROMPT_TEMPLATE, "default": DEFAULT_PROMPT, "levels": LEVELS})
            if route == "logs":
                name = "client" if q.get("file", ["server"])[0] == "client" else "server"
                n = min(int(q.get("tail", ["300"])[0]), 2000)
                f = logger.LOG_DIR / f"{name}.log"
                lines = f.read_text(encoding="utf-8", errors="replace").splitlines()[-n:] if f.exists() else []
                return self._json({"file": f.name, "lines": lines})
            if route == "ping":
                return self.api_debug("/api/debug/ping", q, force=True)
            return self.send_error(404)
        # ---- POST
        if route == "fetch":
            if any(j["status"] == "running" for j in JOBS):
                return self._json({"error": "a download is already running"}, 409)
            tokens = [t for t in re.split(r"[\s,;]+", str(body.get("ids") or body.get("id") or "")) if t][:40]
            if not tokens:
                return self._json({"error": "paste at least one arXiv ID, link or DOI"}, 400)
            job = {"id": ", ".join(tokens)[:120], "ids": tokens, "force": bool(body.get("force")),
                   "status": "running", "output": "", "started": int(time.time())}
            JOBS.append(job)
            threading.Thread(target=self._run_fetch, args=(job,), daemon=True).start()
            return self._json({"ok": True})
        if route == "paper/delete":
            pid = re.sub(r"[^A-Za-z0-9._-]", "", str(body.get("id", "")))
            for ext in (".html", ".json"):
                (PAPERS_DIR / f"{pid}{ext}").unlink(missing_ok=True)
            log.info("dashboard deleted paper %s", pid)
            return self._json({"ok": True})
        if route == "cache/delete":
            n = 0
            targets = list(CACHE_DIR.glob("*.json")) if body.get("all") else [CACHE_DIR / re.sub(r"[^A-Za-z0-9._-]", "", str(body.get("name", "")))]
            for f in targets:
                if f.is_file() and f.parent == CACHE_DIR:
                    f.unlink(); n += 1
            log.info("dashboard deleted %d cache file(s)", n)
            return self._json({"ok": True, "deleted": n})
        if route == "prompt":
            t = str(body.get("template", ""))
            if not all(k in t for k in ("{section}", "{title}", "{level}")):
                return self._json({"error": "template must contain {section}, {title} and {level}"}, 400)
            PROMPT_TEMPLATE = t
            PROMPT_FILE.parent.mkdir(exist_ok=True)
            PROMPT_FILE.write_text(json.dumps({"template": t}), encoding="utf-8")
            log.info("dashboard updated the prompt template")
            return self._json({"ok": True})
        if route == "prompt/reset":
            PROMPT_TEMPLATE = DEFAULT_PROMPT
            PROMPT_FILE.unlink(missing_ok=True)
            return self._json({"ok": True, "template": DEFAULT_PROMPT})
        self.send_error(404)

    @staticmethod
    def _run_fetch(job):
        import fetch_paper                                    # lazy: only needed from the dashboard
        buf, ok_n = io.StringIO(), 0
        job["saved"] = []
        for tok in job["ids"]:                                  # one at a time (arXiv asks for a 3s gap)
            try:
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    pid = fetch_paper.parse_id(tok)
                    if fetch_paper.fetch_one(pid, force=job["force"]):
                        ok_n += 1
                        job["saved"].append(pid.replace("/", "_"))
            except Exception as e:
                buf.write(f"x {tok}: {e}\n")
            job["output"] = buf.getvalue()                      # live progress for the UI
        job["status"] = "done" if ok_n else "failed"
        job["output"] = buf.getvalue()

    # ---- thesis workspace endpoints
    def api_notes(self, d):
        doc = d.get("doc")
        if not isinstance(doc, dict) or not d.get("paper"):
            raise ValueError("need paper + doc")
        old = load_doc(d["paper"])
        doc["brief"] = old.get("brief")                      # the brief is owned by /api/brief
        save_doc(d["paper"], doc)
        return self._json({"ok": True})

    def api_thesis(self, d):
        NOTES_DIR.mkdir(exist_ok=True)
        t = {"topic": str(d.get("topic", ""))[:500], "question": str(d.get("question", ""))[:500]}
        (NOTES_DIR / "_thesis.json").write_text(json.dumps(t), encoding="utf-8")
        return self._json({"ok": True})

    def api_brief(self, d):
        pid = _safe_id(d.get("paperId"))
        doc = load_doc(pid)
        if doc.get("brief") and not d.get("force"):
            return self._json({"brief": doc["brief"], "cached": True})
        try:
            text = paper_text(pid)
        except ValueError as e:
            return self._json({"error": str(e)}, 404)
        thesis = load_thesis()
        prompt = BRIEF_PROMPT.format(thesis=thesis_line(thesis)) + f"\\n\\nPAPER: {paper_title(pid)}\\n\\n{text}"
        log.info("brief %s (%d chars)", pid, len(text))
        t0 = time.time()
        try:
            brief = call_gemini_json(prompt, BRIEF_SCHEMA)
        except GeminiError as e:
            STATS["errors"] += 1
            return self._json({"error": str(e), "code": e.code}, 502)
        STATS["calls"] += 1
        STATS["latencies"].append(int((time.time() - t0) * 1000))
        brief["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        brief["model"] = S.gemini_model
        brief["thesis_topic"] = thesis.get("topic", "")
        doc["brief"] = brief
        save_doc(pid, doc)
        logger.dump("brief", {"prompt_chars": len(prompt), "brief": brief})
        return self._json({"brief": brief, "cached": False})

    def api_ask(self, d):
        pid = _safe_id(d.get("paperId"))
        q = str(d.get("question", "")).strip()[:1500]
        if len(q) < 3:
            raise ValueError("empty question")
        try:
            text = paper_text(pid)
        except ValueError as e:
            return self._json({"error": str(e)}, 404)
        hist = "".join(f"Q: {str(h.get('q', ''))[:300]}\\nA: {str(h.get('a', ''))[:600]}\\n" for h in (d.get("history") or [])[-3:])
        prompt = (ASK_PROMPT.format(thesis=thesis_line(load_thesis())) + f"\\n\\nPAPER: {paper_title(pid)}\\n\\n{text}"
                  + (f"\\n\\nEARLIER CONVERSATION:\\n{hist}" if hist else "") + f"\\n\\nQUESTION: {q}")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if not S.gemini_api_key:
            return self._sse({"type": "error", "code": "no_key", "message": "No GEMINI_API_KEY set. Add it to .env and restart serve.py."})
        log.info("ask %s: %s", pid, q[:80])
        self._sse({"type": "meta", "cached": False, "model": S.gemini_model})
        t0 = time.time()
        try:
            stream_gemini(prompt, lambda c, status=None: self._sse({"type": "status", "message": status} if status else {"type": "chunk", "text": c}), max_tokens=900)
        except GeminiError as e:
            STATS["errors"] += 1
            return self._sse({"type": "error", "code": e.code, "message": str(e)})
        except ClientGone:
            return
        STATS["calls"] += 1
        STATS["latencies"].append(int((time.time() - t0) * 1000))
        self._sse({"type": "done"})

    # ---- /api/explain
    def api_explain(self):
        d = self._read_json()
        paper_id = re.sub(r"[^A-Za-z0-9._-]", "_", str(d.get("paperId") or "paper"))[:60]
        title = str(d.get("title") or "an ML paper")[:300]
        section = str(d.get("section") or "section")[:200]
        text = str(d.get("text") or "")[: S.max_input_chars]
        level = d.get("level") if d.get("level") in LEVELS else S.default_level
        if len(text.strip()) < 30:
            raise ValueError("text too short")

        slug = slugify(section)
        if d.get("kind") == "selection":
            slug += "-" + hashlib.sha1(text.encode()).hexdigest()[:8]
        cache_file = CACHE_DIR / f"{paper_id}_{slug}_{level}.json"

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        if cache_file.exists():                                  # cache hit: no API call, no bill
            try:
                cached = json.loads(cache_file.read_text(encoding="utf-8"))["text"]
                self._sse({"type": "meta", "cached": True, "model": S.gemini_model})
                for i in range(0, len(cached), 40):
                    self._sse({"type": "chunk", "text": cached[i:i + 40]})
                self._sse({"type": "done"})
                STATS["cache_hits"] += 1
                log.info("cache hit %s", cache_file.name)
                return
            except (OSError, ValueError, KeyError):
                log.warning("bad cache file %s, refetching", cache_file.name)

        if not S.gemini_api_key:
            return self._sse({"type": "error", "code": "no_key",
                              "message": "No GEMINI_API_KEY set. Add it to .env and restart serve.py."})

        prompt = PROMPT_TEMPLATE.format(section=section, title=title, level=LEVELS[level]) \
            + "\n\nSECTION TEXT:\n" + text
        log.info("explain %s / %s (%s) %d chars", paper_id, section, level, len(text))
        self._sse({"type": "meta", "cached": False, "model": S.gemini_model})

        def emit(chunk, status=None):
            self._sse({"type": "status", "message": status} if status else {"type": "chunk", "text": chunk})

        t0 = time.time()
        try:
            full = stream_gemini(prompt, emit)
        except GeminiError as e:
            STATS["errors"] += 1
            return self._sse({"type": "error", "code": e.code, "message": str(e)})
        except ClientGone:
            log.info("client left mid-stream")           # partial answer is not cached
            return
        STATS["calls"] += 1
        STATS["latencies"].append(int((time.time() - t0) * 1000))
        del STATS["latencies"][:-200]
        CACHE_DIR.mkdir(exist_ok=True)
        cache_file.write_text(json.dumps({"section": section, "level": level, "model": S.gemini_model,
                                          "text": full}, ensure_ascii=False), encoding="utf-8")
        logger.dump("explain", {"prompt": prompt, "response": full, "model": S.gemini_model,
                                "ms": int((time.time() - t0) * 1000)})
        self._sse({"type": "done"})


def main():
    logger.get("server")
    try:
        httpd = ThreadingHTTPServer((S.host, S.port), Handler)
    except OSError as e:
        raise SystemExit(f"Cannot bind {S.host}:{S.port}: {e}")
    httpd.daemon_threads = True
    log.info("Paper Crawler on http://localhost:%d  | model=%s | key=%s | debug=%s",
             S.port, S.gemini_model, "set" if S.gemini_api_key else "MISSING (AI off)", S.debug)
    if not list(PAPERS_DIR.glob("*.html")):
        log.warning("papers/ is empty. Run: python fetch_paper.py 1706.03762")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
