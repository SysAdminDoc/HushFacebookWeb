// The Download button. It floats over the photo or video under the pointer, inside its own
// closed shadow root, so it never becomes part of Facebook's markup and Facebook's styles
// can't reach it.
//
// Facebook lays clear boxes over its photos and videos, so the pointer is rarely on the media
// itself. What's under it comes from elementsFromPoint, which lists every layer at that spot,
// and failing that from the videos inside the boxes there.

const MIN_SIZE = 160;
const HIDE_AFTER = 450;
const LOOK_UP = 6;

const CSS = `
:host { all: initial; }
button {
  position: fixed; z-index: 2147483000; display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 999px;
  background: rgba(17, 17, 27, 0.82); color: #cdd6f4; font: 600 13px/1 system-ui, sans-serif;
  cursor: pointer; backdrop-filter: blur(8px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  transition: transform 0.12s ease, background 0.12s ease;
}
button:hover { background: rgba(30, 30, 46, 0.95); transform: translateY(-1px); }
button:focus-visible { outline: 2px solid #89b4fa; outline-offset: 2px; }
button[hidden] { display: none; }
button[aria-busy="true"] { cursor: progress; opacity: 0.8; }
svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
`;

const big = (rect) => rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
const inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

// The photo or video at a point, the button itself ('button'), or null.
export function mediaAt(doc, host, x, y) {
  const stack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : [];
  for (const element of stack) {
    if (element === host) return 'button';
    if ((element.tagName === 'VIDEO' || element.tagName === 'IMG') && big(element.getBoundingClientRect())) return element;
  }
  let node = stack[0] ?? null;
  for (let level = 0; node && level < LOOK_UP; level++, node = node.parentElement) {
    for (const video of node.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect();
      if (big(rect) && inside(rect, x, y)) return video;
    }
  }
  return null;
}

// find(element) returns what the button would save ({ ... }) or null. run(found) saves it.
// active() says whether any download switch is on, so nothing is looked up otherwise.
export function createDownloadButton({ doc, win, find, run, active, log }) {
  let host = null;
  let shadow = null;
  let button = null;
  let current = null;
  let found = null;
  let busy = false;
  let hideTimer = null;
  let frame = 0;
  let point = null;

  function mount() {
    if (host?.isConnected) return;
    host = doc.createElement('div');
    host.setAttribute('data-hushfacebook-web', 'download');
    shadow = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    button = doc.createElement('button');
    button.type = 'button';
    button.hidden = true;
    button.addEventListener('click', onClick);
    button.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    button.addEventListener('pointerleave', hideSoon);
    shadow.append(style, button);
    (doc.body ?? doc.documentElement).append(host);
  }

  function label(text) {
    button.replaceChildren();
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14');
    svg.append(path);
    button.append(svg, doc.createTextNode(text));
  }

  function hide() {
    clearTimeout(hideTimer);
    current = null;
    found = null;
    if (button && !busy) button.hidden = true;
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_AFTER);
  }

  function place() {
    if (!current || !button) return;
    const rect = current.getBoundingClientRect();
    if (!current.isConnected || rect.bottom <= 0 || rect.top >= win.innerHeight || !big(rect)) {
      hide();
      return;
    }
    button.style.top = `${Math.max(rect.top, 0) + 10}px`;
    button.style.right = `${Math.max(win.innerWidth - rect.right, 0) + 10}px`;
  }

  function check() {
    frame = 0;
    if (!point || !active()) return;
    mount();
    const target = mediaAt(doc, host, point.x, point.y);
    if (target === 'button') {
      clearTimeout(hideTimer);
      return;
    }
    if (!target) {
      if (current) hideSoon();
      return;
    }
    clearTimeout(hideTimer);
    if (target !== current) {
      let next = null;
      try {
        next = find(target);
      } catch (error) {
        log?.error("Couldn't work out what to download", error);
      }
      if (!next) {
        hideSoon();
        return;
      }
      current = target;
      found = next;
      if (!busy) label('Download');
    }
    button.hidden = false;
    place();
  }

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!found || busy) return;
    busy = true;
    button.setAttribute('aria-busy', 'true');
    label('Saving');
    try {
      await run(found, shadow);
    } catch (error) {
      log?.error('The download failed', error);
    } finally {
      busy = false;
      button.removeAttribute('aria-busy');
      label('Download');
      if (!current) button.hidden = true;
    }
  }

  const onMove = (event) => {
    point = { x: event.clientX, y: event.clientY };
    if (!frame) frame = win.requestAnimationFrame(check);
  };
  const onScroll = () => {
    if (current) win.requestAnimationFrame(place);
  };
  doc.addEventListener('pointermove', onMove, { capture: true, passive: true });
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return {
    hide,
    // For tests: the button's text and whether it shows.
    state: () => ({ shown: Boolean(button && !button.hidden), text: button?.textContent ?? '', top: button?.style.top, right: button?.style.right }),
    click: () => button?.click(),
    stop() {
      doc.removeEventListener('pointermove', onMove, { capture: true });
      win.removeEventListener('scroll', onScroll, { capture: true });
      host?.remove();
    },
  };
}
