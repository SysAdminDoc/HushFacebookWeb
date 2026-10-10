// Console logging plus a ring buffer that the Diagnostics section shows and copies.

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function createLog({ capacity = 400, sink = globalThis.console, now = () => new Date() } = {}) {
  const entries = [];
  const listeners = new Set();

  function write(level, message, detail) {
    const entry = { time: now().toISOString(), level, message: String(message) };
    if (detail !== undefined) entry.detail = describe(detail);
    entries.push(entry);
    if (entries.length > capacity) entries.shift();
    if (level !== 'debug') sink?.[level]?.(`[HushFacebook Web] ${entry.message}`, ...(detail === undefined ? [] : [detail]));
    for (const listener of listeners) listener(entry);
    return entry;
  }

  const log = Object.fromEntries(LEVELS.map((level) => [level, (message, detail) => write(level, message, detail)]));
  log.entries = () => entries.slice();
  log.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return log;
}

function describe(detail) {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}${detail.stack ? `\n${detail.stack}` : ''}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
