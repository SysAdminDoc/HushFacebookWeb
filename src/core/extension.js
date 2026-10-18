// What the browser extension gives the script in place of a userscript manager: storage,
// downloads and the toolbar button, all through the bridge (bridge.js). null in the userscript.
// The first call connects, so it has to happen at document-start, before Facebook's scripts.

import { bridgeDownload, connectBridge, createBridgeStorage } from './bridge.js';
import { TARGET } from './target.js';

// Saved by the background's daily release check (extension/background.js, same key, which lists
// the fields). UPDATE_TOLD_KEY is the version a toast already announced.
export const UPDATE_KEY = 'extensionUpdate';
export const UPDATE_TOLD_KEY = 'extensionUpdate.told';
const RELEASES_PAGE = 'https://github.com/SysAdminDoc/HushFacebookWeb/releases/latest';
const UPDATE_STATES = new Set(['current', 'newer', 'offline', 'rate-limited', 'failed']);
// A check gives up after 15 seconds, so one that says it started longer ago than this ended
// without saying how (Chrome stopped the background in the middle of it).
const CHECK_LASTS = 30 * 1000;

// { version, url } when a newer release is out, else null. With `current`, a record made for
// another version of the extension doesn't count, so an update doesn't announce itself.
export function availableUpdate(storage, current) {
  const record = storage.get(UPDATE_KEY, null);
  if (record?.newer !== true || typeof record.latest !== 'string' || !/^\d+(\.\d+)*$/.test(record.latest)) return null;
  if (current !== undefined && record.current !== current) return null;
  const url = typeof record.url === 'string' && record.url.startsWith('https://github.com/SysAdminDoc/HushFacebookWeb/') ? record.url : RELEASES_PAGE;
  return { version: record.latest, url };
}

// What General says about updates. state is how the last check went, 'waiting' before one has
// run for this version. update is a newer release, kept when a later check fails.
export function updateStatus(storage, current, now = Date.now()) {
  const record = storage.get(UPDATE_KEY, null);
  const time = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const update = availableUpdate(storage, current);
  if (!record || record.current !== current) return { state: 'waiting', update, checking: false, checkedAt: null, triedAt: null, nextAt: null };
  const checking = time(record.checking);
  return {
    // A record from before the state was saved knew only whether a release was newer.
    state: UPDATE_STATES.has(record.state) ? record.state : update ? 'newer' : 'waiting',
    update,
    checking: checking !== null && checking <= now && now - checking < CHECK_LASTS,
    checkedAt: time(record.checkedAt),
    triedAt: time(record.triedAt),
    nextAt: time(record.nextAt),
  };
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
      // { asked, nextAt }: asked is false when the last check was too recent or GitHub asked
      // for a pause, which nextAt ends.
      checkForUpdate: () => bridge.request('update:check', undefined, { timeout: 30000 }),
    };
  }
  return host;
}
