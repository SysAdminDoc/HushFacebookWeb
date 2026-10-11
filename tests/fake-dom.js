// A document as the earliest document-start injection sees it: no <html> yet. addRoot()
// inserts one and tells the MutationObserver, the way the parser would.

export function rootlessDocument() {
  let notify = () => {};
  const doc = {
    documentElement: null,
    head: null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    defaultView: {
      MutationObserver: class {
        constructor(callback) {
          notify = callback;
        }
        observe() {}
        disconnect() {
          notify = () => {};
        }
      },
    },
  };
  const addRoot = (root) => {
    doc.documentElement = root;
    notify([]);
  };
  return { doc, addRoot };
}
