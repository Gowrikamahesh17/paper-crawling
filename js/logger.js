// Client logger: pretty console output + batched forwarding to the server
// (POST /api/log -> logs/client.log) so one place has the whole story.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS.info;
let buf = [];
let timer = null;
export const recent = [];            // last 200 entries, handy in the console / debug page

export function setLevel(name) { minLevel = LEVELS[name] ?? LEVELS.info; }

function safe(data) {
  if (data === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(data, (k, v) => (v instanceof Node ? `<${v.nodeName}>` : v))); }
  catch { return String(data); }
}

function flush() {
  timer = null;
  if (!buf.length) return;
  const entries = buf; buf = [];
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }), keepalive: true }).catch(() => {});
}

function emit(level, scope, msg, data) {
  if (LEVELS[level] < minLevel) return;
  const e = { t: new Date().toISOString(), level, scope, msg, data: safe(data) };
  (console[level] || console.log)(`[${scope}] ${msg}`, data ?? '');
  recent.push(e); if (recent.length > 200) recent.shift();
  buf.push(e); if (buf.length > 300) buf.shift();
  if (!timer) timer = setTimeout(flush, 2000);
}

export const log = {
  debug: (s, m, d) => emit('debug', s, m, d),
  info: (s, m, d) => emit('info', s, m, d),
  warn: (s, m, d) => emit('warn', s, m, d),
  error: (s, m, d) => emit('error', s, m, d),
};

// Catch anything that slips through.
addEventListener('error', (e) => log.error('window', e.message, { src: e.filename, line: e.lineno }));
addEventListener('unhandledrejection', (e) => log.error('promise', String(e.reason)));
addEventListener('pagehide', flush);
