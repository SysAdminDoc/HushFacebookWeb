// Saves a photo or video under a readable name.
//
// The manager's GM_download does it best: the file goes straight to the downloads folder
// under its name. When there's no GM_download, or it fails (Tampermonkey only allows the file
// types on its list, for one), the file is fetched and handed to a download link instead,
// through GM_xmlhttpRequest when the manager has it, since Facebook's servers don't let the
// page itself read their files, and through fetch otherwise.

const TIMEOUT = 120000;
const RESERVED = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

// Control characters, zero-width marks and direction overrides, which can hide a name's
// real ending.
function invisible(code) {
  return code < 0x20 || code === 0x7f || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

// "Pat Example video 1234 HD.mp4". Characters Windows or macOS won't take become spaces.
export function fileName(parts, extension) {
  const joined = parts.filter(Boolean).join(' ').normalize('NFC');
  let clean = '';
  for (const char of joined) clean += RESERVED.has(char) || invisible(char.codePointAt(0)) ? ' ' : char;
  const base = clean.replace(/\s+/g, ' ').trim();
  const cut = [...base].slice(0, 100).join('').trim().replace(/[. ]+$/, '');
  return `${cut || 'Facebook'}.${extension}`;
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

function viaManager(download, url, name) {
  return new Promise((resolve, reject) => {
    download({
      url, name, saveAs: false, timeout: TIMEOUT,
      onload: () => resolve(),
      onerror: (error) => reject(new Error(error?.error || error?.details || 'the manager could not save it')),
      ontimeout: () => reject(new Error('it took too long')),
    });
  });
}

function fetchBlob(url, { request, win }) {
  if (request) {
    return new Promise((resolve, reject) => {
      request({
        method: 'GET', url, responseType: 'blob', timeout: TIMEOUT, anonymous: true,
        onload: (response) => (response.status >= 200 && response.status < 300 && response.response
          ? resolve(response.response)
          : reject(new Error(`the server answered ${response.status}`))),
        onerror: () => reject(new Error("the file couldn't be fetched")),
        ontimeout: () => reject(new Error('it took too long')),
      });
    });
  }
  return win.fetch(url, { credentials: 'omit' }).then((response) => {
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return response.blob();
  });
}

// api: { download, request } from the manager (env.js gmApi), either may be null.
// container: where the temporary link goes, so nothing is added to Facebook's markup.
// Returns 'manager' or 'link', the way it was saved.
export async function saveFile({ url, name, api = {}, doc = globalThis.document, win = globalThis, container = null }) {
  if (api.download) {
    try {
      await viaManager(api.download, url, name);
      return 'manager';
    } catch {
      // Fetch it instead.
    }
  }
  const blob = await fetchBlob(url, { request: api.request, win });
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
  return 'link';
}
