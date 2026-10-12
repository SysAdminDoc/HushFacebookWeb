// Facebook's own module loader. requireLazy(names, callback) calls back with what a module
// exports once it's defined, right away for one that already is. The page sets requireLazy up in
// an inline script in <head>, which runs after a document-start userscript, so this waits for
// the page to parse when it isn't there yet. A module that never loads never calls back.
//
// Facebook's loader reports an error thrown from a callback as its own, with the page's
// tracking data, so the callback runs inside a try and a failure goes to our log instead.
export function whenModule(win, name, callback, { log } = {}) {
  let asked = false;
  const ask = () => {
    if (asked || typeof win.requireLazy !== 'function') return;
    asked = true;
    try {
      win.requireLazy([name], (exports) => {
        try {
          callback(exports);
        } catch (error) {
          log?.error(`Couldn't use Facebook's ${name}`, error);
        }
      });
    } catch (error) {
      log?.error(`Couldn't ask Facebook for ${name}`, error);
    }
  };
  ask();
  if (asked) return;
  win.document?.addEventListener('DOMContentLoaded', ask, { once: true });
  win.addEventListener?.('load', ask, { once: true });
}
