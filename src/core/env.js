// Where the script runs and what the userscript manager gives it. In the browser extension the
// script always runs in the page, and extension.js stands in for the manager.
//
// Network, JSON and media hooks have to patch Facebook's own window. Tampermonkey
// (@sandbox JavaScript) and Violentmonkey (page mode) put the script where unsafeWindow is
// that window. When a manager can only run us as a content script, page hooks would patch
// an isolated copy and do nothing, so features that need the page are skipped and
// Diagnostics says why.

import { extensionHost } from './extension.js';

export const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : globalThis;

export const version = typeof __HFW_VERSION__ !== 'undefined' ? __HFW_VERSION__ : 'dev';

const info = typeof GM_info !== 'undefined' ? GM_info : null;

export const pageAccess = info?.injectInto === 'content' || info?.sandboxMode === 'dom' ? 'content' : 'page';

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

// Runs fn once the document has a body, or right away when it already does.
export function whenBodyReady(fn, doc = globalThis.document) {
  if (doc.body) return fn();
  doc.addEventListener('DOMContentLoaded', () => fn(), { once: true });
}
