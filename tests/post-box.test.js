// Hide the post box on groups and profiles, against the blocks as they were drawn live on
// 2026-11-04 (structure only: tags, roles and the order of things, with made-up names and text).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import hidePostBox, { isPostBox, POST_BOX_CSS, POST_BOX_MARK, postBox } from '../src/features/feed/hide-post-box.js';
import { features } from '../src/features/index.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const PICTURE = '<div><div><svg role="none" aria-hidden="true"><mask id="m"><circle cx="20" cy="20" r="20"></circle></mask><g mask="url(#m)"><image x="0" y="0" height="40" width="40" href="p.jpg"></image><circle cx="20" cy="20" r="20"></circle></g></svg></div></div>';
const ICON_BUTTON = (label) => `<div aria-label="${label}" role="button" tabindex="0"><div><span><img height="24" width="24" alt="" src="i.png"></span><span><span>${label}</span></span></div><div role="none"></div></div>`;
const PROMPT = (text) => `<div role="button" tabindex="0"><div><span>${text}</span></div><div role="none"></div></div>`;
const POST = (n) => `<div><div aria-posinset="${n}"><h4><a href="/someone">Someone</a></h4><div>A post</div>
  <div role="article" aria-label="Comment by Another"><div>Nice</div></div>
  <form><div role="textbox" contenteditable="true"></div><div aria-label="Comment with a photo" role="button"><img src="c.png" alt=""></div><div aria-label="Comment with a GIF" role="button"><img src="g.png" alt=""></div></form>
</div></div>`;

const GROUP_BOX = `<div class="box"><div><div><div><div><span><span><span><a aria-label="Pat Example" href="/groups/1/user/2/" role="link" tabindex="0">${PICTURE}</a></span></span></span>
  ${PROMPT('Write something...')}</div>
  <div><div>${ICON_BUTTON('Anonymous post')}${ICON_BUTTON('Feeling/activity')}${ICON_BUTTON('Poll')}</div></div></div></div></div></div>`;

const GROUP = `<div role="banner"><a href="/">Facebook</a></div>
  <div role="main">
    <div class="header"><h1>Garden Swap</h1><a href="/groups/1/members/">${PICTURE}</a>${PROMPT('Invite')}${ICON_BUTTON('Share')}${ICON_BUTTON('Join')}<div role="tablist"><a role="tab" href="/groups/1/">Discussion</a></div></div>
    <div class="column">
      ${GROUP_BOX}
      <div class="feed"><div role="feed">
        <div class="sort"><div aria-expanded="false" aria-haspopup="dialog" role="button" tabindex="0"><div>Sort</div><h2><span>Most relevant</span></h2><svg aria-hidden="true"></svg></div></div>
        ${POST(1)}${POST(2)}
      </div></div>
    </div>
  </div>
  <div role="dialog"><div class="dialog-box"><a href="/me/" role="link">${PICTURE}</a>${PROMPT('Create post')}${ICON_BUTTON('Photo/video')}${ICON_BUTTON('Tag people')}</div></div>`;

const POSTS_HEADER = `<div class="posts-header"><div><div><h2><span>Posts</span></h2></div></div>
  <div><div aria-label="Filters" role="button" tabindex="0"><svg aria-hidden="true"></svg><span>Filters</span></div><div aria-label="Manage posts" role="button" tabindex="0"><svg aria-hidden="true"></svg><span>Manage posts</span></div></div>
  <div role="tablist"><a role="tab" href="/profile.php?id=1">List view</a><a role="tab" href="/profile.php?id=1&amp;sk=grid">Grid view</a></div></div>`;

const PROFILE_BOX = `<div class="box"><div><div><div><div><div>
  <a aria-label="Pat Example" href="/profile.php?id=1" role="link" tabindex="0">${PICTURE}<div role="none"></div></a>
  ${PROMPT("What's on your mind?")}</div>
  <div>${ICON_BUTTON('Live video')}<input accept="image/*,image/heif,image/heic" multiple type="file">${ICON_BUTTON('Photo/video')}${ICON_BUTTON('Life event')}</div></div></div></div></div></div>`;

const PROFILE = (box = PROFILE_BOX) => `<div role="banner"><a href="/">Facebook</a></div>
  <div role="main">
    <div class="header"><h1>Pat Example</h1>${ICON_BUTTON('Edit profile')}<div role="tablist"><a role="tab" href="/profile.php?id=1">Posts</a></div></div>
    <div class="columns">
      <div class="left"><div><h2>Intro</h2><a href="/profile.php?id=1&amp;sk=photos">${PICTURE}</a>${PROMPT('Add bio')}${ICON_BUTTON('Edit details')}${ICON_BUTTON('Add featured')}</div></div>
      <div class="right">
        ${box}
        ${POSTS_HEADER}
        <div class="feed">${POST(1)}${POST(2)}</div>
      </div>
    </div>
  </div>`;

function page(html, route) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  if (route) win.document.documentElement.dataset.hfwRoute = route;
  win.document.body.innerHTML = html;
  return win;
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hiddenBy = (win) => [...win.document.querySelectorAll(POST_BOX_CSS.split('{')[0])];

test("the box is the block above a group's posts and above your profile's Posts header", () => {
  const group = page(GROUP).document;
  assert.ok(postBox(group) === group.querySelector('.box'), 'the group box');
  const profile = page(PROFILE()).document;
  assert.ok(postBox(profile) === profile.querySelector('.box'), 'the profile box');
});

test("nothing else is a box: a friend's profile with no box, the Posts header, the left column, a header, a dialog, a comment form", () => {
  const friend = page(PROFILE('')).document;
  assert.ok(postBox(friend) === null, "a friend's profile that takes no posts");
  const group = page(GROUP).document;
  for (const name of ['.posts-header', '.left', '.header', '.dialog-box', '.sort', 'form', '[aria-posinset]']) {
    const block = group.querySelector(name) ?? page(PROFILE()).document.querySelector(name);
    assert.equal(isPostBox(block), false, name);
  }
  assert.ok(postBox(page('<div role="main"><div class="column">' + GROUP_BOX + '</div></div>').document) === null, 'no posts, no box');
  assert.ok(postBox(page(GROUP.replace('role="main"', 'class="not-main"')).document) === null, 'only in [role=main]');
});

test('a box missing its picture, its prompt or its buttons is no box', () => {
  const box = (html) => page(html).document.querySelector('.box');
  assert.equal(isPostBox(box(GROUP_BOX)), true);
  assert.equal(isPostBox(box(GROUP_BOX.replace(PICTURE, ''))), false, 'no picture');
  assert.equal(isPostBox(box(GROUP_BOX.replace(PROMPT('Write something...'), ''))), false, 'no prompt');
  assert.equal(isPostBox(box(GROUP_BOX.replace(ICON_BUTTON('Feeling/activity'), '').replace(ICON_BUTTON('Poll'), ''))), false, 'one button');
  assert.equal(isPostBox(box(GROUP_BOX.replace('<div><div>', '<div><h3>Featured</h3><div>'))), false, 'a heading');
});

test('the mark hides the box on groups and profiles only', () => {
  for (const route of ['groups', 'profile']) {
    const win = page(GROUP, route);
    win.document.querySelector('.box').setAttribute(POST_BOX_MARK, '');
    assert.equal(hiddenBy(win).length, 1, route);
  }
  for (const route of ['home', 'search', 'marketplace']) {
    const win = page(GROUP, route);
    win.document.querySelector('.box').setAttribute(POST_BOX_MARK, '');
    assert.equal(hiddenBy(win).length, 0, route);
  }
});

test('setup marks the box on a group and a profile, follows it when it is drawn again, and leaves other pages and the switch off alone', async () => {
  let type = 'groups';
  let on = true;
  const win = page(GROUP, 'groups');
  const doc = win.document;
  hidePostBox.setup({ doc, router: { current: () => ({ type }) }, enabled: () => on });
  await tick(30);
  const marked = () => [...doc.querySelectorAll(`[${POST_BOX_MARK}]`)];
  assert.ok(marked().length === 1 && marked()[0] === doc.querySelector('.box'));

  // Facebook draws the page again: the old box goes, a new one comes.
  doc.querySelector('.box').remove();
  doc.querySelector('.column').insertAdjacentHTML('afterbegin', GROUP_BOX.replace('class="box"', 'class="box again"'));
  await tick(30);
  assert.ok(marked().length === 1 && marked()[0] === doc.querySelector('.again'));

  // Or reuses the block for something else, which loses the mark.
  doc.querySelector('.again').insertAdjacentHTML('afterbegin', '<h2>Featured</h2>');
  await tick(30);
  assert.equal(marked().length, 0, 'a reused block');

  type = 'home';
  doc.body.innerHTML = GROUP;
  await tick(30);
  assert.equal(marked().length, 0, 'Home is left to Hide Stories tray');

  type = 'profile';
  on = false;
  doc.body.innerHTML = PROFILE();
  await tick(30);
  assert.equal(marked().length, 0, 'switched off');
  on = true;
  doc.body.insertAdjacentHTML('beforeend', '<div></div>');
  await tick(30);
  assert.ok(marked().length === 1 && marked()[0] === doc.querySelector('.box'));
});

test('a new address marks or clears the box without waiting for Facebook to change the page', async () => {
  let type = 'home';
  const listeners = [];
  const router = { current: () => ({ type }), subscribe: (listener) => listeners.push(listener) };
  const doc = page(GROUP, 'groups').document;
  hidePostBox.setup({ doc, router, enabled: () => true });
  await tick(30);
  const marked = () => doc.querySelectorAll(`[${POST_BOX_MARK}]`).length;
  assert.equal(marked(), 0, 'Home');
  type = 'groups';
  for (const listener of listeners) listener();
  await tick(30);
  assert.equal(marked(), 1, 'the group the address moved to');
  type = 'home';
  for (const listener of listeners) listener();
  await tick(30);
  assert.equal(marked(), 0, 'no mark left behind for the next group or profile');
});

test('with the switch off from the start, nothing is marked', async () => {
  const doc = page(GROUP, 'groups').document;
  hidePostBox.setup({ doc, router: { current: () => ({ type: 'groups' }) }, enabled: () => false });
  doc.body.insertAdjacentHTML('beforeend', '<div></div>');
  await tick(30);
  assert.equal(doc.querySelectorAll(`[${POST_BOX_MARK}]`).length, 0);
});

test('the switch starts off and is in the Feed section', () => {
  assert.ok(features.includes(hidePostBox));
  assert.equal(hidePostBox.default, false);
  assert.equal(hidePostBox.section, 'feed');
});
