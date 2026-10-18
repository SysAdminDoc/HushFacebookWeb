// Extra Diagnostics rows that features report, shown in the panel and in Copy report.
// A row is a label and a function that returns its current text. Features call changed()
// when a value moves, so an open Diagnostics view redraws.
//
// It also keeps the last 50 decisions to hide something, the way Social Fixer's per-post
// debugger did: which post, which rule, and what matched, so a report says why a post went.
// signal is the script's own name for what matched ('header label', a data rule's id) and goes
// in Copy report. detail is text from the page or the person's filters ('cats') and only shows
// in the panel. Posts are named by a short tag made from their id, and Copy report makes its
// own tags with a fresh salt (src/ui/diagnostic-report.js).
//
// A row's value goes in Copy report only when it's a plain count, or when the row is added with
// { shareable: true } because its text is only the script's own words.

export const DECISIONS = 50;

// FNV-1a, six characters. The same post always gets the same tag under the same salt.
export function postTag(id, salt = '') {
  if (id === null || id === undefined || id === '') return 'no id yet';
  let hash = 0x811c9dc5;
  for (const char of `${salt}${id}`) {
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
    add(label, read, { shareable = false } = {}) {
      rows.set(label, { read, shareable: shareable === true });
      changed();
      return () => {
        rows.delete(label);
        changed();
      };
    },
    rows() {
      return [...rows].map(([label, { read, shareable }]) => {
        let value;
        try {
          value = String(read());
        } catch (error) {
          // The error's text isn't the row's fixed wording, so it stays out of Copy report.
          return { label, value: `unavailable (${error?.message ?? error})`, shareable: false };
        }
        return { label, value, shareable };
      });
    },
    // layer: 'data' when it came out of Facebook's data, 'page' when it was hidden on the page.
    decide({ post, rule, signal, detail, layer }) {
      const text = (value) => (value === null || value === undefined ? '' : String(value));
      decisions.push({
        time: new Date(now()).toISOString().slice(11, 19),
        id: post === null || post === undefined || post === '' ? null : String(post),
        post: postTag(post),
        rule: String(rule),
        signal: text(signal),
        detail: text(detail),
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

// The hider's onHide (src/core/dom/hide.js) feeding the decision list. Its signal is the
// script's own name for what matched and its detail is the post's text that did, and they stay
// apart so the detail never reaches Copy report.
export const hideListener = (diagnostics, idOf) => ({ element, reason, detail, signal }) => diagnostics.decide({ post: idOf(element).id, rule: reason, signal, detail, layer: 'page' });

// One line per decision, for the panel.
export const decisionLine = ({ time, layer, post, rule, signal, detail }) => `${time} ${layer.padEnd(4)} ${post} ${rule}${signal || detail ? `: ${signal || detail}` : ''}`;
