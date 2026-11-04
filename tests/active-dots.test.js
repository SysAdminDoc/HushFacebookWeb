// Hide active status dots, against the corner badges as saved on 2026-10-10 and 2026-10-11
// (structure only: tags, roles and attributes, with made-up names).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import hideActiveDots, { ACTIVE_DOT_SELECTORS, ACTIVE_DOTS_CSS } from '../src/features/appearance/hide-active-dots.js';
import { features } from '../src/features/index.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const DRAWN = 'bottom: 5px; right: 5px; transform: translate(50%, 50%);';
const SERVED = 'bottom:6px;right:6px;transform:translate(50%, 50%)';

const DOT = (style = DRAWN) => `<div class="badge" data-visualcompletion="ignore" style="${style}"><div aria-hidden="false"><div><span data-visualcompletion="ignore"><div>Online status indicator</div></span><div role="none" data-visualcompletion="ignore"></div></div><div>Active</div></div></div>`;
const ICON = (picture) => `<div class="badge" data-visualcompletion="ignore" style="${SERVED}"><div><div aria-hidden="true">${picture}</div><div role="none" data-visualcompletion="ignore"></div></div></div>`;
const DRAWINGS = {
  svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><g><path d="M0 0h16v16H0z"></path></g></svg>',
  i: '<i data-visualcompletion="css-img" style="background-image: url(r.png)"></i>',
  img: '<img height="28" width="28" alt="" aria-hidden="true" src="r.png">',
  background: '<div style="background-image: url(r.png); width: 16px; height: 16px"></div>',
};

let masks = 0;
const PICTURE = (badge = '') => {
  masks += 1;
  const notch = badge ? '<circle class="notch" cx="31" cy="31" data-visualcompletion="ignore" fill="black" r="6"></circle>' : '';
  return `<a class="picture" href="/pat" role="link"><div><svg aria-label="Pat Example" role="img" style="height: 36px; width: 36px;"><mask id="m${masks}"><circle cx="18" cy="18" fill="white" r="18"></circle>${notch}<circle cx="18" cy="18" fill="transparent" r="15" stroke="black" stroke-width="2"></circle></mask><g mask="url(#m${masks})"><image x="4" y="4" height="100%" width="100%" href="p.jpg"></image><circle cx="18" cy="18" r="18"></circle></g></svg><div role="none" data-visualcompletion="ignore"></div>${badge}</div></a>`;
};

function page(html) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div aria-posinset="1">${html}</div></div>`;
  return win.document;
}

// happy-dom reads a chain inside :has() as any one of its parts, so the notch rule (the picture
// beside a dot, and only that one) is checked in a real browser: tests/browser, active-dots.
const [DOT_RULE] = ACTIVE_DOT_SELECTORS;
const found = (doc, selector) => [...doc.querySelectorAll(selector)];
const same = (list, expected) => list.length === expected.length && expected.every((el) => list.includes(el));

test('the dot goes, drawn or as the server sends it', () => {
  const doc = page(PICTURE(DOT()) + PICTURE(DOT(SERVED)));
  const dots = [...doc.querySelectorAll('.badge')];
  assert.equal(dots.length, 2);
  assert.ok(same(found(doc, DOT_RULE), dots));
});

test("a notification's drawing and a picture with no badge are no dot", () => {
  for (const [name, drawing] of Object.entries(DRAWINGS)) {
    assert.equal(found(page(PICTURE(ICON(drawing))), DOT_RULE).length, 0, name);
  }
  assert.equal(found(page(PICTURE()), DOT_RULE).length, 0, 'no badge');
  const shown = page('<div data-visualcompletion="ignore"><div aria-hidden="false"><span>Seen</span></div></div>');
  assert.equal(found(shown, DOT_RULE).length, 0, 'not in a corner');
  const doc = page(PICTURE(ICON(DRAWINGS.svg)) + PICTURE(DOT()));
  assert.ok(same(found(doc, DOT_RULE), [doc.querySelectorAll('.badge')[1]]));
});

test('a shown badge with a picture in it is no dot', () => {
  const doc = page(PICTURE(DOT().replace('<div>Active</div>', `<div>Active</div>${DRAWINGS.img}`)));
  assert.equal(found(doc, DOT_RULE).length, 0);
});

test('the switch starts off, sits in Appearance and is one rule per selector', () => {
  assert.ok(features.includes(hideActiveDots));
  assert.equal(hideActiveDots.default, false);
  assert.equal(hideActiveDots.section, 'layout');
  assert.equal(hideActiveDots.css, ACTIVE_DOTS_CSS);
  assert.equal(ACTIVE_DOTS_CSS.split('{').length - 1, ACTIVE_DOT_SELECTORS.length);
});
