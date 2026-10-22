// Where the script runs and what the userscript manager gives it. In the browser extension the
// script always runs in the page, and extension.js stands in for the manager.
//
// Network, JSON and media hooks have to patch Facebook's own window, from inside the page's
// own JavaScript realm. Tampermonkey (@sandbox raw) and Violentmonkey (page mode) put the
// script there. Tampermonkey's @sandbox JavaScript does too on Chrome, but on Firefox it's an
// Xray sandbox: unsafeWindow is the page's window from another realm, and the page can't call
// the functions or read the option objects we hand it (issue #8). So the realm is checked, not
// taken from the manager's mode. Outside the page realm, page hooks would break Facebook or
// patch an isolated copy, so features that need the page are skipped, the rest use the
// script's own window, and Diagnostics says why.

import { extensionHost } from './extension.js';

// True when code made here belongs to the same realm as the unsafe window. No unsafe window
// means the extension, which always runs in the page. A Firefox Xray window can refuse even
// the read, which counts as another realm.
export function inPageRealm(unsafe, marker = () => {}) {
  if (!unsafe) return true;
  try {
    return marker.constructor === unsafe.Function;
  } catch {
    return false;
  }
}

export function accessFor(info, pageRealm) {
  return !pageRealm || info?.injectInto === 'content' || info?.sandboxMode === 'dom' ? 'content' : 'page';
}

export const version = typeof __HFW_VERSION__ !== 'undefined' ? __HFW_VERSION__ : 'dev';

const info = typeof GM_info !== 'undefined' ? GM_info : null;
const unsafe = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;

export const pageAccess = accessFor(info, inPageRealm(unsafe));

// Content mode gets the script's own window. Violentmonkey's unsafeWindow there isn't its own
// top on Firefox, so the script took itself for a frame and never started.
export const pageWindow = windowFor(unsafe, pageAccess, globalThis);

export function windowFor(unsafe, access, own) {
  return unsafe && access === 'page' ? unsafe : own;
}

export function managerInfo() {
  if (extensionHost()) return { manager: 'Browser extension', managerVersion: version, mode: 'page', pageAccess };
  return {
    manager: info?.scriptHandler ?? 'unknown',
    managerVersion: info?.version ?? 'unknown',
    mode: info?.injectInto ?? info?.sandboxMode ?? 'unknown',
    pageAccess,
  };
}

// The manager's download and request functions, where it grants them.
export function gmApi() {
  const extension = extensionHost();
  if (extension) return { download: extension.download, request: null };
  return {
    download: typeof GM_download === 'function' ? GM_download : null,
    request: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null,
  };
}

// The extension's toolbar button stands in for the manager's menu.
export function registerMenuCommand(label, handler) {
  const extension = extensionHost();
  if (extension) extension.onOpenSettings(handler);
  else if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, handler);
}

// Runs fn once the document has an <html> element, or right away when it already does.
// At document-start there may be none yet (Chrome's earliest injection does this).
export function whenRootReady(fn, doc = globalThis.document) {
  if (!doc || doc.documentElement) return fn();
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new Observer(() => {
    if (!doc.documentElement) return;
    observer.disconnect();
    fn();
  });
  observer.observe(doc, { childList: true });
}

// Runs fn once the document has a body, or right away when it already does. A document that
// finishes with no body never runs it: Firefox fires DOMContentLoaded on the page a
// document_start redirect (Marketplace only) leaves behind, and that page has none.
export function whenBodyReady(fn, doc = globalThis.document) {
  if (doc.body) return fn();
  doc.addEventListener('DOMContentLoaded', () => {
    if (doc.body) fn();
  }, { once: true });
}
