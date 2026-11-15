import assert from 'node:assert/strict';
import { test } from 'node:test';
import directLinks from '../src/features/links/direct-links.js';
import sanitizeLinks from '../src/features/links/sanitize-links.js';
import { testWindow } from './helpers/dom.js';

const SHIM = 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26fbclid%3DIwAR123&h=AT0abc';

// Both link switches on one page, in the features' order, with Facebook's own listener behind them.
function page({ direct = () => true, sanitize = () => true } = {}) {
  const win = testWindow('https://www.facebook.com/');
  const doc = win.document;
  doc.body.innerHTML = '<a id="out">Out</a><a id="in">In</a>';
  sanitizeLinks.setup({ win, net: null, enabled: sanitize });
  directLinks.setup({ win, enabled: direct });
  const heard = [];
  for (const type of ['mousedown', 'click', 'contextmenu']) doc.addEventListener(type, (event) => heard.push(`${type}:${event.target.id}`));
  const press = (id, type) => doc.getElementById(id).dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
  return { win, doc, heard, press };
}

test("an outside link goes straight to the site without its fbclid, and Facebook's handlers never hear the press", () => {
  const { doc, heard, press } = page();
  doc.getElementById('out').setAttribute('href', SHIM);
  press('out', 'mousedown');
  press('out', 'click');
  assert.equal(doc.getElementById('out').getAttribute('href'), 'https://example.com/a?x=1');
  assert.deepEqual(heard, []);
});

test("a Facebook link loses its tracking keys and still reaches Facebook's own handlers", () => {
  const { doc, heard, press } = page();
  doc.getElementById('in').setAttribute('href', '/groups/123/?__tn__=%2CO&ref=share&sorting_setting=CHRONOLOGICAL');
  press('in', 'click');
  assert.equal(doc.getElementById('in').getAttribute('href'), '/groups/123/?sorting_setting=CHRONOLOGICAL');
  assert.deepEqual(heard, ['click:in']);
});

test('a right click cleans the address it would copy, and Facebook still hears it', () => {
  const { doc, heard, press } = page();
  doc.getElementById('out').setAttribute('href', SHIM);
  press('out', 'contextmenu');
  assert.equal(doc.getElementById('out').getAttribute('href'), 'https://example.com/a?x=1');
  assert.deepEqual(heard, ['contextmenu:out']);
});

test('with both switches off a link is left exactly as Facebook wrote it', () => {
  const { doc, heard, press } = page({ direct: () => false, sanitize: () => false });
  doc.getElementById('out').setAttribute('href', SHIM);
  press('out', 'mousedown');
  press('out', 'click');
  assert.equal(doc.getElementById('out').getAttribute('href'), SHIM);
  assert.deepEqual(heard, ['mousedown:out', 'click:out']);
});

test('Sanitize alone keeps the redirect whole, so its u and h stay together', () => {
  const { doc, heard, press } = page({ direct: () => false });
  doc.getElementById('out').setAttribute('href', `${SHIM}&__tn__=-UK-R`);
  press('out', 'click');
  assert.equal(doc.getElementById('out').getAttribute('href'), SHIM);
  assert.deepEqual(heard, ['click:out']);
});
