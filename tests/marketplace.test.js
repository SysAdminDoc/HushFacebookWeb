// View profile on Marketplace sellers against a listing's seller box as drawn live on 2026-10-11
// (shape from captures/2026-10-11-run4 seller, name and ids made up): a Seller details link, the
// seller's picture labelled with their name, and their name, all to /marketplace/profile/<id>/.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import sellerProfileLink, { LABEL, MARK, MAX_ADDS, addProfileLink, createSellerLinks, isListing, nameLinks, sellerId } from '../src/features/marketplace/seller-profile.js';

const FB = 'https://www.facebook.com';
const LISTING = `${FB}/marketplace/item/1234567890123/`;
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const sellerBox = (id = '100000000000001', name = 'Pat Example') => `
<div role="dialog" aria-label="Marketplace listing">
  <h2><span>Seller information</span></h2>
  <div><div><a href="/marketplace/profile/${id}/?product_id=1234567890123" role="link"><span>Seller details</span></a></div></div>
  <div class="seller">
    <div><a aria-label="${name}" href="/marketplace/profile/${id}/?product_id=1234567890123&amp;__tn__=%3C" role="link"><svg aria-hidden="true"><image href="x.jpg"></image></svg></a></div>
    <span><span><div><span><div><a href="/marketplace/profile/${id}/?product_id=1234567890123" role="link"><span>${name}</span></a></div></span></div></span></span>
  </div>
</div>`;

function page(html = sellerBox(), href = LISTING) {
  const win = testWindow(href);
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

const added = (doc) => [...doc.querySelectorAll(`a[${MARK}]`)];

test('a Marketplace profile link gives the seller id, and nothing else does', () => {
  assert.equal(sellerId('/marketplace/profile/100000000000001/?product_id=5', LISTING), '100000000000001');
  assert.equal(sellerId(`${FB}/marketplace/profile/42`, LISTING), '42');
  assert.equal(sellerId('https://web.facebook.com/marketplace/profile/42/', LISTING), '42');
  assert.equal(sellerId('https://evil.example/marketplace/profile/42/', LISTING), null);
  assert.equal(sellerId('/marketplace/profile/pat.example/', LISTING), null);
  assert.equal(sellerId('/marketplace/item/42/', LISTING), null);
  assert.equal(sellerId('http://[bad', LISTING), null);
  assert.ok(isListing(LISTING));
  assert.ok(!isListing(`${FB}/marketplace/`));
  assert.ok(!isListing(`${FB}/marketplace/profile/42/`));
});

test("the link goes after the seller's name, not after the picture or Seller details", () => {
  const win = page();
  const doc = win.document;
  const found = nameLinks(doc, LISTING);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, '100000000000001');
  assert.equal(found[0].link.textContent, 'Pat Example');

  const links = createSellerLinks({ doc, enabled: () => true, setTimer: (fn) => fn() });
  links.sync();
  const [view] = added(doc);
  assert.equal(added(doc).length, 1);
  assert.equal(view.textContent, LABEL);
  assert.equal(view.getAttribute('href'), '/profile.php?id=100000000000001');
  assert.equal(view.previousElementSibling.textContent, 'Pat Example');
  assert.equal(links.added(), 1);
  // Facebook's own links are left as they were.
  assert.equal(doc.querySelectorAll('a[href*="/marketplace/profile/"]').length, 3);
});

test('running again adds nothing, and a reused name points the link at the new seller', () => {
  const win = page();
  const doc = win.document;
  const links = createSellerLinks({ doc, enabled: () => true, setTimer: (fn) => fn() });
  links.sync();
  links.sync();
  assert.equal(added(doc).length, 1);
  // Facebook moved to the next listing and reused the elements.
  for (const link of doc.querySelectorAll('a[href*="/marketplace/profile/"]')) {
    link.setAttribute('href', link.getAttribute('href').replace('100000000000001', '100000000000002'));
  }
  links.sync();
  assert.equal(added(doc).length, 1);
  assert.equal(added(doc)[0].getAttribute('href'), '/profile.php?id=100000000000002');
  assert.equal(links.added(), 1);
});

test('nothing is guessed when no picture link carries the name', () => {
  const win = page(sellerBox().replace(/ aria-label="Pat Example"/, ''));
  const links = createSellerLinks({ doc: win.document, enabled: () => true, setTimer: (fn) => fn() });
  links.sync();
  assert.equal(added(win.document).length, 0);
});

test('only listings get the link, and it goes when you leave or switch it off', () => {
  const win = page(sellerBox(), `${FB}/marketplace/`);
  const doc = win.document;
  let on = true;
  const links = createSellerLinks({ doc, enabled: () => on, setTimer: (fn) => fn() });
  links.sync();
  assert.equal(added(doc).length, 0, 'the Marketplace front page is left alone');
  win.happyDOM.setURL(LISTING);
  links.sync();
  assert.equal(added(doc).length, 1);
  on = false;
  links.sync();
  assert.equal(added(doc).length, 0);
  on = true;
  links.sync();
  assert.equal(added(doc).length, 1);
  win.happyDOM.setURL(`${FB}/marketplace/`);
  links.sync();
  assert.equal(added(doc).length, 0);
});

test('the link comes back after Facebook draws the seller box again', async () => {
  const win = page();
  const doc = win.document;
  const links = createSellerLinks({ doc, enabled: () => true, setTimer: (fn) => win.setTimeout(fn, 0) });
  links.start();
  assert.equal(added(doc).length, 1);
  doc.querySelector('.seller').outerHTML = sellerBox().match(/<div class="seller">[\s\S]*?<\/span><\/span>\s*<\/div>/)[0];
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(added(doc).length, 1);
  assert.equal(links.added(), 2);
});

test('a picture link that also carries the name as text gets no link of its own', () => {
  const win = page(sellerBox().replace('<svg aria-hidden="true">', '<span class="hidden">Pat Example</span><svg aria-hidden="true">'));
  const doc = win.document;
  const links = createSellerLinks({ doc, enabled: () => true, setTimer: (fn) => fn() });
  links.sync();
  assert.equal(added(doc).length, 1);
  assert.equal(added(doc)[0].previousElementSibling.getAttribute('aria-label'), null, 'after the name, not the picture');
});

test('two picture links that both carry the name as text never stand in for the name', () => {
  const picture = (id) => `<div><a aria-label="Pat Example" href="/marketplace/profile/${id}/?__tn__=%3C" role="link"><span class="hidden">Pat Example</span><svg aria-hidden="true"></svg></a></div>`;
  const id = '100000000000001';
  const win = page(`<div role="dialog">${picture(id)}${picture(id)}</div>`);
  const doc = win.document;
  assert.deepEqual(nameLinks(doc, LISTING), []);
  // With the real name link there too, that's the one.
  doc.querySelector('[role="dialog"]').insertAdjacentHTML('beforeend', `<a href="/marketplace/profile/${id}/" role="link"><span>Pat Example</span></a>`);
  const [found] = nameLinks(doc, LISTING);
  assert.equal(found.link.getAttribute('aria-label'), null);
});

test('a page that keeps taking the link away gets it back only so many times', () => {
  const win = page();
  const doc = win.document;
  const links = createSellerLinks({ doc, enabled: () => true, setTimer: (fn) => fn() });
  for (let i = 0; i < MAX_ADDS + 10; i++) {
    links.sync();
    for (const link of added(doc)) link.remove();
  }
  assert.equal(links.added(), MAX_ADDS);
  // A new listing starts its own count.
  win.happyDOM.setURL(`${FB}/marketplace/item/2234567890123/`);
  links.sync();
  assert.equal(added(doc).length, 1);
});

test('off a listing, page changes schedule no work', async () => {
  const win = page('<div id="feed"></div>', `${FB}/marketplace/`);
  const doc = win.document;
  let scheduled = 0;
  const links = createSellerLinks({ doc, enabled: () => true, setTimer: (fn) => { scheduled++; return win.setTimeout(fn, 0); } });
  links.start();
  for (let i = 0; i < 5; i++) doc.getElementById('feed').append(doc.createElement('div'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(scheduled, 0);
  win.happyDOM.setURL(LISTING);
  doc.body.insertAdjacentHTML('beforeend', sellerBox());
  await new Promise((resolve) => setTimeout(resolve, 20));
  // One for the seller box, one for the script's own link, which changes nothing and stops there.
  assert.equal(scheduled, 2);
  assert.equal(added(doc).length, 1);
});

test('the feature registers a diagnostics row and styles only its own link', () => {
  const win = page();
  const rows = [];
  sellerProfileLink.setup({ doc: win.document, enabled: () => true, diagnostics: { add: (label, read) => rows.push([label, read]) } });
  assert.equal(rows[0][0], 'Seller profile links added');
  assert.equal(rows[0][1](), '1');
  assert.equal(sellerProfileLink.default, true);
  assert.equal(sellerProfileLink.section, 'marketplace');
  assert.ok(sellerProfileLink.css.includes(`a[${MARK}]`));
  assert.ok(!/(^|\n)\s*a\s*\{/.test(sellerProfileLink.css));
});

test('a link is added straight after the name element', () => {
  const win = page();
  const doc = win.document;
  const [found] = nameLinks(doc, LISTING);
  assert.equal(addProfileLink(doc, found), true);
  assert.equal(addProfileLink(doc, found), false);
  assert.equal(found.link.nextElementSibling.getAttribute(MARK), '100000000000001');
});
