// View profile on Marketplace sellers in a real engine. The link sits in a shadow root on the
// name's box (a node put into the server's markup made React throw #418, live 2026-11-15), after
// a slot that shows the box's own children. Whether that draws on the name's line, takes
// Facebook's link color and is reached by Tab is only known here: happy-dom lays nothing out.
import { addProfileLink, nameLinks, shownLink } from '../../../src/features/marketplace/seller-profile.js';
import { check } from './helpers.js';

const FB = 'https://www.facebook.com';
const ID = '100000000000001';
// The seller box as drawn live on 2026-10-11 (captures/2026-10-11-run4 seller, name and id made up).
const BOX = `<div role="dialog" aria-label="Marketplace listing">
  <div><a aria-label="Pat Example" href="${FB}/marketplace/profile/${ID}/?__tn__=%3C" role="link"><svg aria-hidden="true" width="36" height="36"><circle cx="18" cy="18" r="18" fill="#b0b3b8"/></svg></a></div>
  <span><span><div><span><div><a id="name" href="${FB}/marketplace/profile/${ID}/" role="link"><span>Pat Example</span></a></div></span></div></span></span>
  <a id="after" href="#after">Next thing</a>
</div>`;
const LINK_COLOR = 'rgb(10, 120, 250)';

let box;
let view;

export function prepareSeller() {
  document.documentElement.style.setProperty('--blue-link', LINK_COLOR);
  document.body.insertAdjacentHTML('beforeend', BOX);
  const [found] = nameLinks(document, `${FB}/marketplace/item/1234567890123/`);
  check(found?.id === ID, 'The name link was not found');
  box = found.link.parentElement;
  check(addProfileLink(document, found), 'No link was added');
  view = shownLink(box);
  check(view?.textContent === 'View profile', 'The link is not on the name\'s box');
  check(box.childNodes.length === 1 && found.link.nextSibling === null, "Facebook's nodes changed");

  const name = found.link.getBoundingClientRect();
  const shown = view.getBoundingClientRect();
  check(shown.width > 40 && shown.height > 10, `The link draws no box (${Math.round(shown.width)} x ${Math.round(shown.height)})`);
  check(shown.left >= name.right && shown.left - name.right < 16, `The link is not right after the name (gap ${Math.round(shown.left - name.right)} px)`);
  check(Math.abs(shown.top - name.top) < 6, 'The link dropped below the name');
  const style = getComputedStyle(view);
  check(style.color === LINK_COLOR, `The link does not take Facebook's link color (${style.color})`);
  check(!style.textDecorationLine.includes('underline'), 'The link is underlined before a hover');
  // A click there lands on the link: the page sees the box, the shadow root the link.
  const x = shown.left + shown.width / 2;
  const y = shown.top + shown.height / 2;
  check(document.elementFromPoint(x, y) === box && box.shadowRoot.elementFromPoint(x, y) === view, 'Something covers the link');
  return { gap: Math.round(shown.left - name.right), width: Math.round(shown.width) };
}

// Where focus is: 'name', 'view', 'after' or something else.
export function sellerFocus() {
  const active = document.activeElement;
  if (active === box) return box.shadowRoot.activeElement === view ? 'view' : 'box';
  return active?.id || active?.localName || 'none';
}
