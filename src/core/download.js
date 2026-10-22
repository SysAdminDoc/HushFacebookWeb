// Saves a photo or video under a readable name.
//
// The manager's GM_download does it best: the file goes straight to the downloads folder
// under its name. When there's no GM_download, or it fails (Tampermonkey only allows the file
// types on its list, for one), the file is fetched and handed to a download link instead,
// through GM_xmlhttpRequest when the manager has it, since Facebook's servers don't let the
// page itself read their files, and through fetch otherwise.
//
// A video Facebook only streams comes as two parts, its picture and its sound. Both are
// fetched the same way, joined into one MP4 (mp4-merge.js) and saved through the link.

import { mergeTracks } from './mp4-merge.js';

// A long HD video on a slow connection takes minutes, and the limit covers the whole transfer.
const TIMEOUT = 600000;
const RESERVED = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

// Control characters, zero-width marks, soft hyphens, direction marks and overrides (which can
// hide a name's real ending), and the tag characters inside flag emoji, which Chrome's
// downloads refuse.
function invisible(code) {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xad || code === 0x61c || code === 0x180e
    || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f)
    || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb) || (code >= 0xe0000 && code <= 0xe007f);
}

// "Pat Example video 1234 HD.mp4". Characters Windows or macOS won't take become spaces.
export function fileName(parts, extension) {
  const joined = parts.filter(Boolean).join(' ').normalize('NFC');
  let clean = '';
  for (const char of joined) clean += RESERVED.has(char) || invisible(char.codePointAt(0)) ? ' ' : char;
  // A leading dot or tilde would make a hidden or backup file.
  const base = clean.replace(/\s+/g, ' ').trim().replace(/^[.~ ]+/, '');
  const cut = [...base].slice(0, 100).join('').trim().replace(/[. ]+$/, '');
  // Windows keeps CON, NUL, COM1 and the like for devices, and the downloads refuse them.
  const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cut) ? `Facebook ${cut}` : cut;
  return `${safe || 'Facebook'}.${extension}`;
}

// Facebook's image server converts files on the way out, and its stp setting says to what:
// ".../1_n.png?stp=dst-jpg_tt6" is a JPEG. That wins over the address's own ending.
export function extensionOf(url, fallback) {
  try {
    const parsed = new URL(url);
    const found = parsed.searchParams.get('stp')?.match(/(?:^|_)dst-(jpe?g|png|webp|gif)/i)
      ?? parsed.pathname.match(/\.(mp4|m4v|webm|jpe?g|png|gif|webp|heic)$/i);
    return found ? found[1].toLowerCase().replace('jpeg', 'jpg') : fallback;
  } catch {
    return fallback;
  }
}

// A manager's error fields can be text or an object (the browser's own error, say).
const describe = (value) => (value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
const cancelledError = (cause) => Object.assign(new Error('you cancelled it', cause ? { cause } : undefined), { cancelled: true });

// Each try hands back how to stop it: the abort() of the manager's handle, or of the fetch's
// AbortController. Managers don't all keep to the timeout they're given (an anonymous
// GM_xmlhttpRequest can run on), so the deadline is the save's own and covers every try.

function viaManager(download, url, name, timeout) {
  let handle = null;
  const done = new Promise((resolve, reject) => {
    handle = download({
      url, name, saveAs: false, timeout,
      onload: () => resolve(),
      onerror: (error) => reject(Object.assign(new Error(describe(error?.error) || describe(error?.details) || 'the manager could not save it'), {
        cancelled: /cancel/i.test(`${describe(error?.error)} ${describe(error?.details)}`),
        // The extension's downloads: the browser took the file and then stopped, so another
        // try would only hide why.
        final: error?.final === true,
      })),
      ontimeout: () => reject(new Error('it took too long')),
    });
  });
  return { done, abort: () => handle?.abort?.() };
}

// type: 'blob', or 'arraybuffer' for a part to be joined, so it isn't held as a Blob and a
// copy of it at once.
function fetchBlob(url, { request, win, timeout, type = 'blob' }) {
  if (request) {
    let handle = null;
    const done = new Promise((resolve, reject) => {
      handle = request({
        method: 'GET', url, responseType: type, timeout, anonymous: true,
        onload: (response) => (response.status >= 200 && response.status < 300 && response.response
          ? resolve(response.response)
          : reject(new Error(`the server answered ${response.status}`))),
        onerror: () => reject(new Error("the file couldn't be fetched")),
        ontimeout: () => reject(new Error('it took too long')),
      });
    });
    return { done, abort: () => handle?.abort?.() };
  }
  const controller = new (win.AbortController ?? AbortController)();
  const done = win.fetch(url, { credentials: 'omit', signal: controller.signal }).then((response) => {
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return type === 'arraybuffer' ? response.arrayBuffer() : response.blob();
  });
  return { done, abort: () => controller.abort() };
}

// A video's parts, fetched at once. One failing stops the rest, since the save is over then.
function fetchParts(parts, options) {
  const tries = parts.map((part) => fetchBlob(part, { ...options, type: 'arraybuffer' }));
  const abort = () => tries.forEach((step) => step.abort());
  const done = Promise.all(tries.map((step) => step.done));
  done.catch(abort);
  return { done, abort };
}

// Any fault in the parts (a file cut short reads past its end too) gets the reason a save's
// notice shows, with the merger's own kept for the log.
function joinParts(picture, sound) {
  try {
    return mergeTracks(new Uint8Array(picture), sound ? new Uint8Array(sound) : null);
  } catch (error) {
    throw new Error("the video and its sound didn't fit together", { cause: error });
  }
}

function saveThroughLink(blob, name, doc, container) {
  const href = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  (container ?? doc.body ?? doc.documentElement).append(link);
  link.click();
  link.remove();
  // The browser has the file by then. In Node (the tests) the timer mustn't hold the process.
  setTimeout(() => URL.revokeObjectURL(href), 60000).unref?.();
}

// api: { download, request } from the manager (env.js gmApi), either may be null.
// parts: in place of url, a picture and a sound address to fetch together and join.
// container: where the temporary link goes, so nothing is added to Facebook's markup.
// Returns { done, cancel }. done resolves 'manager' or 'link', the way it was saved, or rejects
// (error.cancelled when the person cancelled, here or in the browser). It settles once, and
// whatever ends it first (the save, an error, cancel() or the deadline) stops the try that's
// running. A cancel or the deadline never starts the next try.
export function startSave({ url, parts = null, name, api = {}, doc = globalThis.document, win = globalThis, container = null, deadline = TIMEOUT }) {
  let over = false;
  let running = null;
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = (error, how) => {
      if (over) return false;
      over = true;
      clearTimeout(timer);
      const stop = running;
      running = null;
      if (error) {
        reject(error);
        try {
          stop?.abort();
        } catch {
          // The manager's own abort failing changes nothing here: the save is over.
        }
      } else resolve(how);
      return true;
    };
  });
  const timer = setTimeout(() => settle(new Error('it took too long')), deadline);
  const attempt = async (step) => {
    running = step;
    try {
      return await step.done;
    } finally {
      if (running === step) running = null;
    }
  };

  const run = async () => {
    if (parts) {
      const [picture, sound] = await attempt(fetchParts(parts, { request: api.request, win, timeout: deadline }));
      if (over) return undefined;
      const pieces = joinParts(picture, sound);
      saveThroughLink(new (win.Blob ?? Blob)(pieces, { type: 'video/mp4' }), name, doc, container);
      return 'link';
    }
    if (api.download) {
      try {
        await attempt(viaManager(api.download, url, name, deadline));
        return 'manager';
      } catch (error) {
        if (over) return undefined;
        // Cancelled in the browser means no, and a final error stands. Anything else, fetch it instead.
        if (error.cancelled) throw cancelledError(error);
        if (error.final) throw error;
      }
    }
    const blob = await attempt(fetchBlob(url, { request: api.request, win, timeout: deadline }));
    if (over) return undefined;
    saveThroughLink(blob, name, doc, container);
    return 'link';
  };
  run().then((how) => settle(null, how), (error) => settle(error));
  return { done, cancel: () => settle(cancelledError()) };
}

export function saveFile(options) {
  return startSave(options).done;
}
