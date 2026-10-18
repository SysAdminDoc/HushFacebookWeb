// Hide Follow and Join buttons, against post headers shaped like Facebook's (live 2026-10-12).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import hideFollowButtons, { MARK, createFollowHider, labelName, markFollowButtons } from '../src/features/feed/hide-follow-buttons.js';
import { features } from '../src/features/index.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const dotted = (verb, label) => `<span dir="auto"><span><span>&nbsp;</span><span aria-hidden="true"> · </span></span><div aria-label="${label}" role="button" tabindex="0">${verb}</div></span>`;

function page(body) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = body;
  return win;
}

const post = (header, rest = '') => `<div aria-posinset="1"><h4><a href="/groups/venice">Venice Beach Florida</a></h4>
  <div><span><a href="/cynthia">Cynthia Ravinski</a></span>${header}</div>
  <div><a href="/x/posts/1">2h</a></div>${rest}
  <div role="button" aria-label="Like">Like</div></div>`;

const marked = (doc) => [...doc.querySelectorAll(`[${MARK}]`)].map((node) => node.querySelector('[role="button"]').textContent);

test("a post's Follow and Join beside names are marked, dot and all", () => {
  const win = page(post(dotted('Follow', 'Follow Cynthia Ravinski'), `<h4>${dotted('Join', 'Join Venice Beach Florida')}</h4>`));
  assert.equal(markFollowButtons(win.document), 2);
  assert.deepEqual(marked(win.document), ['Follow', 'Join']);
  assert.ok(win.document.querySelector(`[${MARK}]`).textContent.includes('·'), 'the dot goes with it');
  assert.equal(markFollowButtons(win.document), 0, 'once each');
});

test('any language: the rest of the label only has to be a name the post shows', () => {
  const win = page(post(dotted('Seguir', 'Seguir a Cynthia Ravinski')));
  markFollowButtons(win.document);
  assert.deepEqual(marked(win.document), ['Seguir']);
  assert.equal(labelName(win.document.querySelector('[aria-label^="Seguir"]')), 'a cynthia ravinski');
});

test('other dotted buttons, the name itself and buttons outside posts stay', () => {
  const win = page(`${post(dotted('More', 'More options for in'), dotted('Like', 'Like'))}
    <footer><a href="/privacy">Privacy</a>${dotted('More', 'More footer links')}</footer>
    <div>${dotted('Follow', 'Follow Cynthia Ravinski')}</div>
    <div aria-posinset="2"><a href="/rin">in</a>${dotted('Follow', 'Follow Ravinski')}</div>
    <div aria-posinset="3"><a href="/p">Pat Lee</a><span><span><span aria-hidden="true"> · </span></span><a href="/p">Pat Lee</a><div role="button" aria-label="Follow Pat Lee">Follow</div></span></div>`);
  assert.equal(markFollowButtons(win.document), 0);
});

test('the switch starts off, hides through its style, and marks new posts as they come', async () => {
  assert.equal(hideFollowButtons.default, false);
  assert.equal(hideFollowButtons.section, 'feed');
  assert.ok(features.includes(hideFollowButtons));
  assert.match(hideFollowButtons.css, /display: none/);
  const win = page('');
  let on = false;
  const timers = [];
  const hider = createFollowHider({ doc: win.document, enabled: () => on, setTimer: (fn) => timers.push(fn) });
  hider.start();
  win.document.body.innerHTML = post(dotted('Follow', 'Follow Cynthia Ravinski'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timers.length, 0, 'nothing while off');
  on = true;
  win.document.body.insertAdjacentHTML('beforeend', post(dotted('Join', 'Join Venice Beach Florida')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  timers.splice(0).forEach((run) => run());
  assert.equal(hider.marked(), 2);
});
