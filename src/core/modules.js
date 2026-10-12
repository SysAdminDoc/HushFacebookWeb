// Facebook's own module loader. requireLazy(names, callback) calls back with what a module
// exports once it's defined, right away for one that already is. The page sets requireLazy up in
// an inline script in <head>, which runs after a document-start userscript, so this waits for
// the page to parse when it isn't there yet. A module that never loads never calls back.
//
// Asking runs the module's code on the spot, so whenModule is only for modules that read nothing
// from the page when they run. afterModuleRuns below waits for Facebook's own code instead.
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

// Facebook defines each module with __d(name, deps, factory, flags), and its loader runs the
// factory the first time Facebook's own code asks for the module, as
// factory(global, require, importDefault, importNamespace, requireLazy, module, exports).
// The page starts with a stub __d that queues definitions, set in the same inline script as
// requireLazy, then swaps its loader in with a plain assignment (live 2026-10-11, run 66).
//
// afterModuleRuns hands over a module's exports right after its factory runs, and never asks
// for the module itself. A factory that reads one of Facebook's experiment values throws when
// it runs before the page has that value, and the loader keeps the failure. Live 2026-10-11:
// the feed refresh limits asked for through requireLazy as Tampermonkey started the script
// left Feeds, and Home with the Following feed on, stuck on Facebook's splash screen.
//
// __d becomes a getter and setter on the window, so the loader Facebook assigns later goes
// through a wrapper. A module defined before the script could wrap __d is never handed
// over, which leaves it as Facebook made it.
const hooks = new WeakMap();
const factoryHooks = new WeakMap();

export function afterModuleRuns(win, name, callback, { log } = {}) {
  let hook = hooks.get(win);
  if (!hook) {
    hook = { watchers: new Map(), installed: false };
    hooks.set(win, hook);
    waitForDefiner(win, hook);
  }
  if (!hook.watchers.has(name)) hook.watchers.set(name, []);
  hook.watchers.get(name).push({ name, callback, log });
}

function waitForDefiner(win, hook) {
  if (wrapDefiner(win, hook)) return;
  let observer = null;
  const attempt = () => {
    if (wrapDefiner(win, hook)) observer?.disconnect();
  };
  // The stub turns up in an inline script in <head>. A mutation callback runs before the
  // parser gets to the next script, so the wrapper is in place before any bundle defines a
  // module.
  if (typeof win.MutationObserver === 'function' && win.document) {
    try {
      observer = new win.MutationObserver(attempt);
      observer.observe(win.document, { childList: true, subtree: true });
    } catch {
      observer = null;
    }
  }
  win.document?.addEventListener('DOMContentLoaded', attempt, { once: true });
  win.addEventListener?.('load', () => observer?.disconnect(), { once: true });
}

function wrapDefiner(win, hook) {
  if (hook.installed) return true;
  if (typeof win.__d !== 'function') return false;
  const own = Object.getOwnPropertyDescriptor(win, '__d');
  if (own && !own.configurable) return false;
  // A replacement can capture the previous wrapper and delegate to it. Each wrapper must
  // keep its own target instead of calling the latest replacement again.
  const wrap = (delegate) => {
    if (typeof delegate !== 'function') return delegate;
    return function __d(name, deps, factory) {
      const watchers = hook.watchers.get(name);
      if (!watchers || typeof factory !== 'function') return delegate.apply(this, arguments);
      const args = Array.prototype.slice.call(arguments);
      args[2] = afterFactory(win, factory, watchers);
      return delegate.apply(this, args);
    };
  };
  let current = wrap(win.__d);
  Object.defineProperty(win, '__d', {
    configurable: true,
    enumerable: own ? own.enumerable : true,
    get: () => current,
    set: (next) => {
      if (next !== current) current = wrap(next);
    },
  });
  hook.installed = true;
  return true;
}

function afterFactory(win, factory, watchers) {
  if (factoryHooks.get(factory) === watchers) return factory;
  const wrapped = function () {
    const result = factory.apply(this, arguments);
    const exports = exportsOf(win, arguments);
    if (exports) {
      for (const { name, callback, log } of watchers) {
        try {
          callback(exports);
        } catch (error) {
          log?.error(`Couldn't use Facebook's ${name}`, error);
        }
      }
    }
    return result;
  };
  // The loader may read how many arguments a factory takes.
  try {
    Object.defineProperty(wrapped, 'length', { value: factory.length });
  } catch {
    // An engine that won't change a function's length still runs the wrapper.
  }
  factoryHooks.set(wrapped, watchers);
  return wrapped;
}

// The module object is the argument with an exports object on it.
function exportsOf(win, args) {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && arg !== win && arg.exports && typeof arg.exports === 'object') return arg.exports;
  }
  return null;
}
