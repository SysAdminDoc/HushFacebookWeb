// The picker behind Hide parts of the page. While it runs, the part of Facebook under the
// pointer gets an outline, and a click picks it instead of doing what it would on Facebook. A
// picked part shows hidden at once, as a preview, and a bar at the top offers Save, Bigger,
// Smaller, Pick another and Cancel. Escape cancels too.
//
// Nothing is written on Facebook's elements. The outline and the bar live in the panel's own
// shadow root, and the preview is a style element of the script's own. Every pointer, mouse,
// touch and key event outside the script's own elements stops at the window while the picker
// runs, so Facebook never hears a click, a hover, a right click or a key until it's done. Tab
// stays in the bar.
//
// The events reach the picker through one set of window listeners the script adds as it starts
// (guardForPicking), ahead of its own features' window listeners (Following feed's and
// Marketplace only's clicks, Keep posts hidden's) and of keepKeysInPanel, which would stop
// Escape on the bar before a listener added later saw it.
//
// root: where the bar and outline go, inside host's shadow root.
// rules: { ruleFor(node) => { line } | { refused }, cssFor(line), describe(line) }

import { t } from '../core/i18n.js';
import { h } from './h.js';

const BLOCKED = ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mousedown',
  'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'click', 'auxclick', 'dblclick', 'contextmenu'];
// Stopped but not cancelled, so a tap still makes the click that picks.
const TOUCH = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
const KEYS = ['keydown', 'keypress', 'keyup'];
const GATED = [...BLOCKED, ...TOUCH, ...KEYS];
const POINTING_CURSOR = 'html, html * { cursor: crosshair !important; }';

const gates = new WeakMap();

// The window listeners every picker in this window goes through. Added once, as the script starts.
export function guardForPicking(win) {
  if (gates.has(win)) return;
  const gate = { active: null };
  gates.set(win, gate);
  for (const type of GATED) win.addEventListener(type, (event) => gate.active?.(event), { capture: true, passive: TOUCH.includes(type) });
}

function refusalText(reason) {
  switch (reason) {
    case 'feed': return t("That's part of a post or the feed. To hide posts, use Hide posts by words on the Feed page.");
    case 'big': return t('That would hide most of the page. Pick something smaller.');
    case 'ours': return t("That's HushFacebook Web's own. Point at a part of Facebook.");
    default: return t("Couldn't tell that part apart from others like it. Try Bigger, or pick something next to it.");
  }
}

export function startPartPicker({ root, host, doc, win, rules, onSave, onEnd }) {
  let state = 'pointing';
  let candidate = null;
  let hovered = null;
  let result = null;
  let outlined = null;
  let ended = false;
  const smaller = [];

  const preview = doc.createElement('style');
  preview.dataset.hushfacebookWeb = 'part-preview';
  preview.textContent = POINTING_CURSOR;
  (doc.head ?? doc.documentElement).append(preview);

  const outline = h('div', { class: 'picker-outline', hidden: true });
  const title = h('div', { class: 'picker-title', id: 'hfw-picker-title' });
  const hint = h('div', { class: 'picker-hint' });
  const button = (key, label, run, primary = false) => h('button', { class: `button${primary ? ' primary' : ''}`, type: 'button', dataset: { key: `picker:${key}` }, text: t(label), onclick: run });
  const buttons = {
    save: button('save', 'Save', () => save(), true),
    bigger: button('bigger', 'Bigger', () => bigger()),
    smaller: button('smaller', 'Smaller', () => shrink()),
    again: button('again', 'Pick another', () => pointAgain()),
    cancel: button('cancel', 'Cancel', () => end(false)),
  };
  const bar = h('div', { class: 'picker', role: 'region', tabindex: '-1', 'aria-labelledby': 'hfw-picker-title' },
    h('div', { class: 'picker-text', role: 'status' }, title, hint),
    h('div', { class: 'actions' }, Object.values(buttons)));
  root.append(outline, bar);

  const ours = (event) => (typeof event.composedPath === 'function' ? event.composedPath().includes(host) : event.target === host);
  const elementOf = (event) => {
    const target = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
    return target?.nodeType === 1 ? target : target?.parentElement ?? null;
  };
  const boxOf = (node) => node.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
  const sameBox = (a, b) => {
    const one = boxOf(a);
    const two = boxOf(b);
    return one.width * one.height > 0 && ['left', 'top', 'width', 'height'].every((side) => Math.abs(one[side] - two[side]) < 1);
  };
  // Words, icons and boxes that draw nothing of their own (display: contents).
  const inline = (node) => /^(inline\b|contents$)/.test(win.getComputedStyle?.(node)?.display ?? '') || node.namespaceURI === 'http://www.w3.org/2000/svg';
  const top = (node) => !node.parentElement || node.parentElement === doc.body || node.parentElement === doc.documentElement;

  // What a pointer at node would pick: out of words and icons to the box holding them, then
  // through wrappers the same size as what they hold.
  function boxFor(node) {
    let box = node;
    while (!top(box) && inline(box)) box = box.parentElement;
    while (!top(box) && sameBox(box, box.parentElement)) box = box.parentElement;
    return box;
  }

  function draw(node, refused = false) {
    outlined = { node, refused };
    const rect = node?.isConnected ? boxOf(node) : null;
    outline.hidden = !rect || rect.width * rect.height === 0;
    outline.classList.toggle('refused', refused);
    if (outline.hidden) return;
    Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  function show() {
    const picked = state === 'picked';
    title.textContent = !picked ? t('Point at a part of Facebook and click it') : result.line ? rules.describe(result.line) : refusalText(result.refused);
    hint.textContent = !picked ? t('Nothing on the page reacts to clicks until you save or cancel.')
      : result.line ? t('It shows hidden now. Save keeps it hidden, and Bigger or Smaller changes what goes.') : '';
    buttons.save.hidden = !picked;
    buttons.save.disabled = !result?.line;
    buttons.bigger.hidden = !picked;
    buttons.bigger.disabled = !candidate || top(candidate);
    buttons.smaller.hidden = !picked;
    buttons.smaller.disabled = !smaller.length;
    buttons.again.hidden = !picked;
    preview.textContent = picked ? (result.line ? rules.cssFor(result.line) : '') : POINTING_CURSOR;
    draw(picked && !result.line ? candidate : picked ? null : hovered, picked);
  }

  function choose(node) {
    candidate = node;
    state = 'picked';
    result = rules.ruleFor(node);
    show();
    const next = result.line ? buttons.save : result.refused === 'unclear' && !buttons.bigger.disabled ? buttons.bigger : buttons.again;
    next.focus({ preventScroll: true });
  }

  function bigger() {
    if (!candidate || top(candidate)) return;
    // Measured with the preview off, since a hidden part has no size.
    preview.textContent = '';
    let next = candidate.parentElement;
    while (!top(next) && sameBox(next, candidate)) next = next.parentElement;
    smaller.push(candidate);
    choose(next);
  }

  function shrink() {
    if (smaller.length) choose(smaller.pop());
  }

  function pointAgain() {
    state = 'pointing';
    candidate = null;
    hovered = null;
    result = null;
    smaller.length = 0;
    show();
    bar.focus({ preventScroll: true });
  }

  function save() {
    if (!result?.line) return;
    const { line } = result;
    end(true);
    onSave(line);
  }

  // The bar starts at the top, over Facebook's own top bar. When the pointer is on something the
  // bar covers, the bar moves to the other end of the screen, so every part can be reached.
  function dodge(node, event) {
    const area = bar.getBoundingClientRect?.();
    const box = node ? boxOf(node) : null;
    if (!area || !box) return;
    const covers = box.left < area.right && area.left < box.right && box.top < area.bottom && area.top < box.bottom;
    const low = bar.classList.contains('low');
    // Only from the bar's own half of the screen, so a part as tall as the screen doesn't bounce it.
    if (covers && (event.clientY > win.innerHeight / 2) === low) bar.classList.toggle('low', !low);
  }

  // Facebook hears none of it: no hover card, no menu, no link followed.
  const block = (event) => {
    if (ours(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (state !== 'pointing') return;
    const node = elementOf(event);
    if (event.type === 'pointermove') {
      hovered = node ? boxFor(node) : null;
      dodge(hovered, event);
      draw(hovered);
    } else if (event.type === 'click' && node) {
      choose(boxFor(node));
    }
  };
  // Tab and Shift+Tab go around the bar's buttons.
  const wrapTab = (event) => {
    const stops = Object.values(buttons).filter((item) => !item.hidden && !item.disabled);
    const focused = bar.getRootNode().activeElement;
    const to = event.shiftKey ? (focused === bar || focused === stops[0] ? stops.at(-1) : null) : focused === stops.at(-1) ? stops[0] : null;
    if (!to) return;
    event.preventDefault();
    to.focus({ preventScroll: true });
  };
  const key = (event) => {
    if (event.type === 'keydown' && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      end(false);
      return;
    }
    if (ours(event)) {
      if (event.type === 'keydown' && event.key === 'Tab') wrapTab(event);
      return;
    }
    // Focus somewhere on Facebook (from before the picker, say): its keys wait, and focus comes back.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'keydown') bar.focus({ preventScroll: true });
  };
  const touch = (event) => {
    if (!ours(event)) event.stopImmediatePropagation();
  };
  const handle = (event) => {
    if (KEYS.includes(event.type)) key(event);
    else if (TOUCH.includes(event.type)) touch(event);
    else block(event);
  };
  // Only the outline moves with the page. The preview stays as it is.
  const redraw = () => draw(outlined?.node, outlined?.refused);
  const gate = gates.get(win);
  const listeners = [
    ...(gate ? [] : GATED.map((type) => [type, handle])),
    ['scroll', redraw],
    ['resize', redraw],
  ];
  if (gate) gate.active = handle;
  for (const [type, run] of listeners) win.addEventListener(type, run, { capture: true, passive: type === 'scroll' || TOUCH.includes(type) });

  function end(saved) {
    if (ended) return;
    ended = true;
    if (gate?.active === handle) gate.active = null;
    for (const [type, run] of listeners) win.removeEventListener(type, run, { capture: true });
    preview.remove();
    outline.remove();
    bar.remove();
    onEnd?.({ saved });
  }

  show();
  bar.focus({ preventScroll: true });
  return { stop: () => end(false), state: () => ({ state, line: result?.line ?? null, refused: result?.refused ?? null }) };
}
