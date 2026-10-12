// What the browser extension gives the script in place of a userscript manager: storage,
// downloads and the toolbar button, all through the bridge (bridge.js). null in the userscript.
// The first call connects, so it has to happen at document-start, before Facebook's scripts.

import { bridgeDownload, connectBridge, createBridgeStorage } from './bridge.js';
import { TARGET } from './target.js';

let host;

export function extensionHost() {
  if (TARGET !== 'extension') return null;
  if (!host) {
    const bridge = connectBridge();
    host = {
      bridge,
      storage: createBridgeStorage(bridge),
      download: bridgeDownload(bridge),
      onOpenSettings: (run) => bridge.on('open-settings', run),
    };
  }
  return host;
}
