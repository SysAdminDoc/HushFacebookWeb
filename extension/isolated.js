// The extension's isolated half. It runs beside the page script (src/core/bridge.js) in its own
// world, where chrome.storage and the messages to the background work, and answers the page
// script's requests over DOM events named with the secret the page script makes.
//
// The first well-formed hello wins. Both halves start at document_start, before any of
// Facebook's scripts, so the hello it hears is the page script's own.

import { HELLO_ISOLATED, HELLO_MAIN, channelNames } from '../src/core/bridge.js';

const SECRET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let channel = null;

const toMain = (message) => document.dispatchEvent(new CustomEvent(channel.toMain, { detail: JSON.stringify(message) }));

const handlers = {
  'storage:load': () => chrome.storage.local.get(null),
  'storage:set': ({ key, value }) => (value === null ? chrome.storage.local.remove(key) : chrome.storage.local.set({ [key]: value })),
  'storage:remove': ({ key }) => chrome.storage.local.remove(key),
  download: async ({ url, name }) => {
    const answer = await chrome.runtime.sendMessage({ type: 'download', url, name });
    if (!answer?.ok) throw new Error(answer?.error || 'the browser could not save it');
  },
};

async function onRequest(event) {
  let message;
  try {
    message = JSON.parse(event.detail);
  } catch {
    return;
  }
  const { id, type, payload } = message ?? {};
  const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
  if (!Number.isInteger(id)) return;
  try {
    if (!handler) throw new Error(`unknown request ${type}`);
    const result = await handler(payload ?? {});
    toMain({ id, ok: true, result: result ?? null });
  } catch (error) {
    toMain({ id, ok: false, error: String(error?.message ?? error) });
  }
}

document.addEventListener(HELLO_MAIN, (event) => {
  if (channel || typeof event.detail !== 'string' || !SECRET.test(event.detail)) return;
  channel = channelNames(event.detail);
  document.addEventListener(channel.toIsolated, onRequest);
  toMain({ ready: true });

  // Changes from other tabs and the extension's own pages. This tab's writes come back too,
  // and the page script skips those.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const data = {};
    for (const [key, { newValue }] of Object.entries(changes)) data[key] = newValue ?? null;
    toMain({ push: 'storage', data });
  });
  // The toolbar button.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'open-settings') toMain({ push: 'open-settings' });
  });
});

// For when the page script started first and its hello went unheard.
document.dispatchEvent(new CustomEvent(HELLO_ISOLATED));
