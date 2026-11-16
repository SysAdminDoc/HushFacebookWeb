import { createActions } from '../../../src/core/actions.js';
import { createDiagnostics } from '../../../src/core/diagnostics.js';
import { createHider } from '../../../src/core/dom/hide.js';
import { createLog } from '../../../src/core/log.js';
import { createSettings } from '../../../src/core/settings.js';
import { startFeatures } from '../../../src/core/start-features.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { mountFeatureStyles, renderFeatureCss } from '../../../src/core/style.js';
import hideParts from '../../../src/features/appearance/hide-parts.js';
import { matchRule, parseRule, selectorFor } from '../../../src/features/appearance/part-rules.js';
import { keepKeysInPanel } from '../../../src/ui/keys.js';
import { mountPanel } from '../../../src/ui/panel.js';
import { guardForPicking } from '../../../src/ui/part-picker.js';
import { check, delay } from './helpers.js';

// Hide parts of the page in a real browser: real pointer moves draw the outline over the right
// box, real clicks pick instead of reaching the page, and the saved line's CSS hides exactly what
/// the matcher finds. The driver in runner.mjs moves the mouse and presses the keys. The window
// listeners go on in boot's order, the picker's first, then keepKeysInPanel, then a feature's own
// click listener, and the page is stamped Home the way the router stamps it.

const PAGE = `<style>
  #hfw-parts-page { display: grid; grid-template-columns: 200px 1fr 240px; gap: 12px; align-items: start; }
  #hfw-parts-page [role="banner"] { grid-column: 1 / -1; height: 56px; display: flex; justify-content: center; align-items: center; gap: 32px; border-bottom: 1px solid #768599; }
  #hfw-parts-page [role="contentinfo"] { position: fixed; left: 0; right: 0; bottom: 0; height: 40px; border-top: 1px solid #768599; background: #242526; }
  #hfw-parts-page ul { list-style: none; margin: 0; padding: 0; }
  #hfw-parts-page li { padding: 6px; }
  #hfw-parts-page li a { display: inline-flex; gap: 6px; align-items: center; }
  #hfw-parts-page .box, #hfw-parts-page [role="article"] { padding: 12px; border: 1px solid #768599; margin-bottom: 12px; }
  #hfw-parts-page h3 { margin: 0 0 6px; font-size: 16px; }
</style>
<div id="hfw-parts-page">
  <div role="banner" id="topbar"><a href="/watch/" id="watch-tab">Video</a><a href="/gaming/">Gaming</a></div>
  <div role="navigation" aria-label="Shortcuts"><ul>
    <li><a href="/friends/"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#8abfff"/></svg><span>Friends</span></a></li>
    <li id="market-row"><a href="/marketplace/"><svg id="market-icon" width="20" height="20" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" fill="#8abfff"/></svg><span>Marketplace</span></a></li>
    <li><a href="/groups/feed/"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#a6e3a1"/></svg><span>Groups</span></a></li>
  </ul></div>
  <div role="main"><div role="feed">
    <div role="article" aria-posinset="1"><p id="post-text">A post in the feed, which the picker must refuse.</p></div>
    <div role="article" aria-posinset="2"><p>Another post.</p></div>
  </div></div>
  <div role="complementary"><div class="column">
    <div class="box" id="sponsored"><h3>Sponsored</h3><p>An ad box.</p></div>
    <div class="box" id="requests"><h3>Friend requests</h3><a href="/friends/requests/">See all</a></div>
    <div class="box" id="birthdays"><h3>Birthdays</h3><p>No birthdays today.</p></div>
  </div></div>
  <div role="contentinfo" id="footer"></div>
</div>`;

let state;
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))));
const rectOf = (node) => {
  const { left, top, width, height } = node.getBoundingClientRect();
  return { left, top, width, height };
};

export async function preparePicker() {
  guardForPicking(window);
  keepKeysInPanel(window);
  document.documentElement.dataset.hfwRoute = 'home';
  // main.js stamps the running version on <html>, so every part of the page sits inside that mark.
  document.documentElement.setAttribute('data-hushfacebook-web', '0.0.47');
  const errors = [];
  const log = createLog({ sink: { info() {}, warn() {}, error: (message) => errors.push(String(message)) } });
  const storage = createMemoryStorage();
  const settings = createSettings({ storage, features: [hideParts], log });
  const actions = createActions();
  document.body.insertAdjacentHTML('beforeend', PAGE);
  const heard = [];
  // The page's own listeners, like Facebook's: they hear what reaches them and never navigate.
  for (const type of ['click', 'mousedown', 'mouseover', 'pointerdown', 'contextmenu']) {
    document.getElementById('hfw-parts-page').addEventListener(type, (event) => {
      heard.push(type);
      if (type === 'click') event.preventDefault();
    });
  }
  // One of the script's own features, like Following feed's click listener on the window, added
  // as the script starts. It acts on clicks in the page, never on the panel's.
  for (const type of ['click', 'pointerdown']) {
    window.addEventListener(type, (event) => {
      if (event.target?.closest?.('#hfw-parts-page')) heard.push(`feature ${type}`);
    }, true);
  }
  let shadow;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (init) {
    const found = attach.call(this, init);
    if (this.dataset.hushfacebookWeb === 'ui') shadow = found;
    return found;
  };
  const panel = mountPanel({
    settings, features: [hideParts], log, hider: createHider({ doc: document, log }), diagnostics: createDiagnostics(),
    actions, unavailable: new Map(),
    environment: { version: __HFW_VERSION__, manager: 'Local fixture', managerVersion: '1', mode: 'page', pageAccess: 'page', storage },
  });
  HTMLElement.prototype.attachShadow = attach;
  const style = mountFeatureStyles({ features: [hideParts], settings, log });
  startFeatures({
    features: [hideParts], net: null, settings, log, unavailable: new Map(), changed: () => panel.refresh(),
    context: (feature) => ({ doc: document, win: window, actions: actions.for(feature.id), toast: panel.toast, pickPart: (options) => panel.pickPart(options) }),
  });
  // Whatever had focus before the panel opened gets it back when the panel closes, unless the
  // picker is what closed it.
  const opener = document.createElement('button');
  opener.id = 'opener';
  opener.textContent = 'Local page settings';
  document.body.append(opener);
  opener.focus();
  panel.open('appearance');
  await frames();
  state = { panel, settings, storage, shadow, opener, heard, style, log, errors };
  return focusPick();
}

// Focus on the card's Pick a part to hide, ready for Enter.
export async function focusPick() {
  await frames();
  const { shadow } = state;
  const pick = [...shadow.querySelectorAll('main button')].find((item) => item.textContent === 'Pick a part to hide');
  check(Boolean(pick), 'Appearance has no Pick a part to hide button');
  pick.focus();
  return { focused: shadow.activeElement === pick };
}

// A post Facebook puts into a hidden part later brings the part back, since a rule never hides
// posts. Gone again, the part hides again.
export async function postInto(id) {
  const part = document.getElementById(id);
  const post = document.createElement('div');
  post.setAttribute('role', 'article');
  post.setAttribute('aria-posinset', '3');
  post.textContent = 'A post that turned up in the column.';
  part.append(post);
  await frames();
  const withPost = getComputedStyle(part).display;
  post.remove();
  await frames();
  return { withPost, after: getComputedStyle(part).display };
}

// How the part shows on another kind of page, the router's stamp put back after.
export async function displayOn({ id, route }) {
  const root = document.documentElement;
  const was = root.dataset.hfwRoute;
  root.dataset.hfwRoute = route;
  await frames();
  const display = getComputedStyle(document.getElementById(id)).display;
  root.dataset.hfwRoute = was;
  await frames();
  return display;
}

// Where the picker stands, in booleans, keys and boxes.
export async function pickerState() {
  await frames();
  const { shadow, settings, heard, opener, errors } = state;
  const bar = shadow.querySelector('.picker');
  const outline = shadow.querySelector('.picker-outline');
  const active = shadow.activeElement;
  // The newest notice: one that comes while the panel's regions settle waits in a box after them.
  const toast = [...shadow.querySelectorAll('.toast')].at(-1);
  return {
    dialogOpen: shadow.querySelector('dialog').open,
    picker: Boolean(bar),
    barLow: Boolean(bar) && bar.getBoundingClientRect().top > innerHeight / 2,
    barFocused: Boolean(bar) && active === bar,
    focused: active?.dataset?.key ?? (active === bar && bar ? 'picker' : null),
    openerFocused: document.activeElement === opener,
    title: shadow.querySelector('.picker-title')?.textContent ?? null,
    outline: outline && !outline.hidden ? { ...rectOf(outline), refused: outline.classList.contains('refused') } : null,
    preview: Boolean(document.querySelector('style[data-hushfacebook-web="part-preview"]')),
    parts: settings.get('hideParts.parts'),
    toast: toast?.textContent ?? '',
    undo: [...(toast?.querySelectorAll('button') ?? [])].some((item) => item.textContent === 'Undo'),
    heard: [...heard],
    errors: [...errors],
  };
}

// The box of a page element, and the point to move the mouse to: its centre, or near its top
// left corner for a padded box, so the pointer lands on the box itself and not its words.
export function pointAt({ id, corner = false }) {
  const node = document.getElementById(id);
  check(Boolean(node), `No element #${id}`);
  const rect = rectOf(node);
  return { rect, x: corner ? rect.left + 4 : rect.left + rect.width / 2, y: corner ? rect.top + 4 : rect.top + rect.height / 2 };
}

export function boxOf(id) {
  return rectOf(document.getElementById(id));
}

export function displayOf(id) {
  return getComputedStyle(document.getElementById(id)).display;
}

export function clearHeard() {
  state.heard.length = 0;
}

// After Save: the saved CSS hides exactly what the matcher finds, the browser's own selector
// engine agrees with it, and settings read back from storage build the same CSS, as after a reload.
export async function savedPart() {
  await delay(20);
  const { settings, storage, style, log } = state;
  const line = settings.get('hideParts.parts');
  const rule = parseRule(line);
  check(Boolean(rule), `The saved text is no rule: ${line}`);
  const page = document.getElementById('hfw-parts-page');
  const expected = new Set(matchRule(rule, document));
  const hidden = [...page.querySelectorAll('*')].filter((node) => node.localName !== 'style' && getComputedStyle(node).display === 'none');
  const selected = new Set(document.querySelectorAll(selectorFor(rule)));
  const fresh = createSettings({ storage, features: [hideParts], log });
  return {
    line,
    matched: expected.size,
    cssHidesMatched: hidden.length === expected.size && hidden.every((node) => expected.has(node)),
    selectorAgrees: selected.size === expected.size && [...selected].every((node) => expected.has(node)),
    styleHasRule: style.textContent.includes(hideParts.css(settings.get)) && hideParts.css(settings.get).length > 0,
    afterReload: renderFeatureCss([hideParts], fresh, log) === renderFeatureCss([hideParts], settings, log),
  };
}

// The Appearance card with the saved part listed, scrolled into view, and its Show again button.
export async function showList() {
  state.panel.open('appearance');
  await frames();
  const list = state.shadow.querySelector('[data-links-for="hideParts"]');
  check(Boolean(list), 'The card has no list of parts');
  list.scrollIntoView({ block: 'center' });
  await frames();
  const button = list.querySelector('.link-action');
  const label = list.querySelector('.link-label');
  return {
    items: list.querySelectorAll('li').length,
    label: label?.textContent ?? '',
    named: Boolean(button && label) && button.getAttribute('aria-labelledby') === `${button.id} ${label.id}`,
    button: button ? rectOf(button) : null,
  };
}
