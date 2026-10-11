// Extra Diagnostics rows that features report, shown in the panel and in Copy report.
// A row is a label and a function that returns its current text. Features call changed()
// when a value moves, so an open Diagnostics view redraws.

export function createDiagnostics() {
  const rows = new Map();
  const listeners = new Set();

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
    changed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
