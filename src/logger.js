// Minimal structured logger.
// Output format (one line per event):
//   2026-10-10T05:00:01.123Z INFO  [report] HR day written date=2026-10-09 extensionId=123 inbound=4
// warn/error go to stderr (PM2 error log), debug/info go to stdout (PM2 out log).
//
// Secrets must never reach the logs. Callers only pass aggregate fields, but as a
// second line of defence any field whose name looks sensitive is redacted.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(token|secret|jwt|password|passwd|authorization|cookie|credential|private_?key|subject|text|body|payload|attachment)/i;

function formatValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return /[\s="]/.test(value) || value === '' ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

export function sanitizeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[REDACTED]';
    } else if (value instanceof Error) {
      out[key] = value.message;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeFields(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createLogger({ level = 'info', scope = '', stdout = process.stdout, stderr = process.stderr, clock = () => new Date() } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const safe = sanitizeFields(fields);
    const parts = [clock().toISOString(), lvl.toUpperCase().padEnd(5)];
    if (scope) parts.push(`[${scope}]`);
    parts.push(msg);
    for (const [k, v] of Object.entries(safe)) parts.push(`${k}=${formatValue(v)}`);
    const line = parts.join(' ') + '\n';
    (LEVELS[lvl] >= LEVELS.warn ? stderr : stdout).write(line);
  }

  return {
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (childScope) => createLogger({ level, scope: scope ? `${scope}:${childScope}` : childScope, stdout, stderr, clock }),
  };
}

export function createSilentLogger() {
  const noop = () => {};
  const logger = { level: 'silent', debug: noop, info: noop, warn: noop, error: noop };
  logger.child = () => logger;
  return logger;
}
