// What the browser extension gives the script in place of a userscript manager: storage,
// downloads and the toolbar button, all through the bridge (bridge.js). null in the userscript.
// The first call connects, so it has to happen at document-start, before Facebook's scripts.

import { bridgeDownload, connectBridge, createBridgeStorage } from './bridge.js';
import { TARGET } from './target.js';

// Saved by the background's daily release check (extension/background.js, same key):
// { at, current, latest, url, newer }. UPDATE_TOLD_KEY is the version a toast already announced.
export const UPDATE_KEY = 'extensionUpdate';
export const UPDATE_TOLD_KEY = 'extensionUpdate.told';
const RELEASES_PAGE = 'https://github.com/SysAdminDoc/HushFacebookWeb/releases/latest';

// { version, url } when a newer release is out, else null.
export function availableUpdate(storage) {
  const record = storage.get(UPDATE_KEY, null);
  if (record?.newer !== true || typeof record.latest !== 'string' || !/^\d+(\.\d+)*$/.test(record.latest)) return null;
  const url = typeof record.url === 'string' && record.url.startsWith('https://github.com/SysAdminDoc/HushFacebookWeb/') ? record.url : RELEASES_PAGE;
  return { version: record.latest, url };
}

let host;

export function extensionHost({ log } = {}) {
  if (TARGET !== 'extension') return null;
  if (!host) {
    const bridge = connectBridge();
    host = {
      bridge,
      storage: createBridgeStorage(bridge, { log }),
      download: bridgeDownload(bridge),
      onOpenSettings: (run) => bridge.on('open-settings', run),
    };
  }
  return host;
}
