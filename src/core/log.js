// Console logging plus a ring buffer that the Diagnostics section shows and copies. Copy report
// takes the message and, for the detail, only its code: an error's name, or the kind of value.
// So a message holds the script's own words, and anything from the page or the person's
// settings (an address, a file name, a filter line) goes in the detail.

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function createLog({ capacity = 400, sink = globalThis.console, now = () => new Date() } = {}) {
  const entries = [];
  const listeners = new Set();

  function write(level, message, detail) {
    const entry = { time: now().toISOString(), level, message: String(message) };
    if (detail !== undefined) {
      entry.detail = describe(detail);
      entry.code = codeOf(detail);
    }
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

// An error's name ('TypeError', 'NotAllowedError'), from any window, else what kind of value it was.
function codeOf(detail) {
  let name;
  try {
    name = detail !== null && typeof detail === 'object' ? detail.name : undefined;
  } catch {
    // A detail whose name can't be read is reported by its kind.
  }
  return typeof name === 'string' && /^[A-Z][A-Za-z]{0,39}$/.test(name) ? name : typeof detail;
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
