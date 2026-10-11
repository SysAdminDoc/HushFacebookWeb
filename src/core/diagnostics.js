// Extra Diagnostics rows that features report, shown in the panel and in Copy report.
// A row is a label and a function that returns its current text. Features call changed()
// when a value moves, so an open Diagnostics view redraws.
//
// It also keeps the last 50 decisions to hide something, the way Social Fixer's per-post
// debugger did: which post, which rule, and the signal that matched, so a report says why a
// post went. Posts are named by a short tag made from their id, so a pasted report doesn't
// carry the ids of what someone saw.

export const DECISIONS = 50;

// FNV-1a, six characters. The same post always gets the same tag.
export function postTag(id) {
  if (id === null || id === undefined || id === '') return 'no id yet';
  let hash = 0x811c9dc5;
  for (const char of String(id)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `#${hash.toString(36).padStart(6, '0').slice(-6)}`;
}

export function createDiagnostics({ now = () => Date.now() } = {}) {
  const rows = new Map();
  const listeners = new Set();
  const decisions = [];

  function changed() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }

  return {
    add(label, read) {
      rows.set(label, read);
      changed();
      return () => {
        rows.delete(label);
        changed();
      };
    },
    rows() {
      return [...rows].map(([label, read]) => {
        let value;
        try {
          value = String(read());
        } catch (error) {
          value = `unavailable (${error?.message ?? error})`;
        }
        return { label, value };
      });
    },
    // layer: 'data' when it came out of Facebook's data, 'page' when it was hidden on the page.
    decide({ post, rule, signal, layer }) {
      decisions.push({
        time: new Date(now()).toISOString().slice(11, 19),
        post: postTag(post),
        rule: String(rule),
        signal: signal === null || signal === undefined ? '' : String(signal),
        layer: layer === 'data' ? 'data' : 'page',
      });
      if (decisions.length > DECISIONS) decisions.splice(0, decisions.length - DECISIONS);
      changed();
    },
    // Oldest first.
    decisions: () => decisions.map((decision) => ({ ...decision })),
    changed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// One line per decision, for the panel and the report.
export const decisionLine = ({ time, layer, post, rule, signal }) => `${time} ${layer.padEnd(4)} ${post} ${rule}${signal ? `: ${signal}` : ''}`;
