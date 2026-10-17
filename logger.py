"""Logging + debug dumps. Everything goes to logs/ (rotating files) and the console.

  logs/server.log   - server + fetch_paper.py events
  logs/client.log   - browser events forwarded through POST /api/log
  debug/dumps/      - raw prompt/response JSON per AI call (only when DEBUG_DUMP=1)
"""
import json
import logging
import time
from logging.handlers import RotatingFileHandler

import config

LOG_DIR = config.ROOT / "logs"
DEBUG_DIR = config.ROOT / "debug"
DUMP_DIR = DEBUG_DIR / "dumps"
_FMT = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%H:%M:%S")
_ready = False


def _setup():
    global _ready
    if _ready:
        return
    LOG_DIR.mkdir(exist_ok=True)
    root = logging.getLogger("crawler")
    root.setLevel(getattr(logging, config.S.log_level, logging.INFO))
    fh = RotatingFileHandler(LOG_DIR / "server.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    sh = logging.StreamHandler()
    for h in (fh, sh):
        h.setFormatter(_FMT)
        root.addHandler(h)
    cl = logging.getLogger("crawler_client")          # separate file for browser logs
    cl.setLevel(logging.DEBUG)
    cl.propagate = False
    ch = RotatingFileHandler(LOG_DIR / "client.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    ch.setFormatter(logging.Formatter("%(message)s"))
    cl.addHandler(ch)
    _ready = True


def get(name):
    _setup()
    return logging.getLogger("crawler." + name)


def client_log(entries):
    """Persist browser log entries (list of dicts) to logs/client.log."""
    _setup()
    cl = logging.getLogger("crawler_client")
    for e in entries[:200]:
        cl.info(json.dumps(e, ensure_ascii=False)[:2000])


def dump(name, obj):
    """Save a debug artefact to debug/dumps/ when DEBUG_DUMP=1 (keeps the newest 100)."""
    if not config.S.debug_dump:
        return
    DUMP_DIR.mkdir(parents=True, exist_ok=True)
    path = DUMP_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}_{name}.json"
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
    files = sorted(p for p in DUMP_DIR.glob("*.json"))
    for old in files[:-100]:
        old.unlink(missing_ok=True)
