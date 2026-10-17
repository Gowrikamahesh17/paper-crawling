"""Shared settings. Reads .env (real environment variables win) and exposes
a typed `S` object used by serve.py, fetch_paper.py and logger.py.
Standard library only."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_env(path=ROOT / ".env"):
    """Tiny .env parser: KEY=VALUE lines, # comments, optional quotes."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key, val = key.strip(), val.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        elif " #" in val:                      # inline comment
            val = val.split(" #", 1)[0].rstrip()
        os.environ.setdefault(key, val)


load_env()


def _get(name, default=""):
    v = os.environ.get(name)
    return default if v is None or v == "" else v


def _num(name, default, cast):
    try:
        return cast(_get(name, default))
    except (TypeError, ValueError):
        return default


class Settings:
    gemini_api_key = _get("GEMINI_API_KEY")
    gemini_model = _get("GEMINI_MODEL", "gemini-2.5-flash")
    gemini_base = _get("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
    temperature = _num("GEMINI_TEMPERATURE", 0.4, float)
    max_output_tokens = _num("GEMINI_MAX_OUTPUT_TOKENS", 512, int)
    thinking_budget = _num("GEMINI_THINKING_BUDGET", 0, int)
    min_interval = _num("GEMINI_MIN_INTERVAL", 6.5, float)
    default_level = _get("DEFAULT_LEVEL", "student")
    max_input_chars = _num("MAX_INPUT_CHARS", 12000, int)
    host = _get("HOST", "127.0.0.1")
    port = _num("PORT", 5173, int)
    log_level = _get("LOG_LEVEL", "INFO").upper()
    debug = _get("DEBUG", "0") in ("1", "true", "True", "yes")
    debug_dump = _get("DEBUG_DUMP", "0") in ("1", "true", "True", "yes")
    arxiv_contact = _get("ARXIV_CONTACT", "unknown@example.com")
    arxiv_delay = _num("ARXIV_DELAY", 3.0, float)


S = Settings()
