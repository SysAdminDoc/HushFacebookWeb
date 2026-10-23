// Screenshot mode against the shapes seen live on 2026-10-22, signed out (NASA's Page, one of
// its posts and its comments, a public group, a public reel), with made-up names. The left and
// right columns follow declutter.test.js's Home and the column's usual contact row.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import screenshotMode, { NAMES, PICTURES, SCREENSHOT_CSS } from '../src/features/appearance/screenshot-mode.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const FB = 'https://www.facebook.com';
const PIC = (id, extra = '') => `<svg id="${id}" ${extra}><mask><circle></circle></mask><g><image></image><circle></circle></g></svg>`;

const PAGE = `
<div role="banner"><div role="navigation" aria-label="Account Controls and Settings">
  <div role="button" aria-label="Your profile">${PIC('me-pic')}</div>
</div></div>
<div role="navigation" aria-label="Shortcuts"><ul>
  <li><a id="left-own" href="${FB}/profile.php?id=615000000000001">${PIC('left-own-pic')}<span>Pat Example</span></a></li>
  <li><a id="left-friends" href="${FB}/friends/?ref=bookmarks"><i></i><span>Friends</span></a></li>
  <li><a id="left-groups" href="${FB}/groups/?ref=bookmarks"><i></i><span>Groups</span></a></li>
  <li><a id="left-shortcut" href="${FB}/groups/1234567890/">${PIC('left-shortcut-pic')}<span>Garden Club</span></a></li>
</ul></div>
<div role="main">
  <img id="cover" data-imgperflogname="profileCoverPhoto" src="cover.jpg">
  <h1 id="page-title">Example Page</h1>
  <a id="group-about" href="${FB}/groups/gardenclub/about/">About</a>
  <a id="group-media" href="/groups/gardenclub/media/">Media</a>
  <h2 id="photos-heading"><span><a id="photos-link" href="${FB}/examplepage/photos/">Photos</a></span></h2>
  <svg id="icon" viewBox="0 0 16 16"><path d="M1 1"></path></svg>

  <div aria-posinset="1">
    <a href="${FB}/examplepage?__cft__[0]=x">${PIC('post-pic', 'role="img" aria-label="Example Page"')}</a>
    <div data-ad-rendering-role="profile_name" id="post-author"><h2><span><a href="${FB}/examplepage?__cft__[0]=x"><b><span>Example Page</span></b></a></span> is with <a href="${FB}/a.friend">A Friend</a></h2></div>
    <span><a id="post-time" href="${FB}/examplepage/posts/pfbid0abc">October 15 at 11:04 AM</a></span>
    <div data-ad-rendering-role="story_message"><div dir="auto">Thanks to <a id="post-mention" href="${FB}/OtherPage?__cft__[0]=x">Other Page</a> <a id="post-hashtag" href="${FB}/hashtag/space?__eep__=6">#space</a> <a id="post-out" href="https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.facebook.com%2Fx">example.com</a></div></div>
    <a href="${FB}/photo/?fbid=1"><img id="post-photo" alt="May be an image of outer space" src="photo.jpg"></a>
    <div role="button" aria-label="Like: 14K people"><img id="reaction" role="presentation" src="like.svg"></div>

    <div role="article" aria-label="Comment by Ann Example a week ago">
      <div><div>${PIC('c1-pic', 'role="none"')}</div></div>
      <div><div><div><div><div>
        <span id="c1-name"><span dir="auto">Ann Example</span></span>
        <div><span dir="auto" lang="en"><div><div dir="auto" id="c1-text">Lovely <span><img id="emoji" alt="🙂" src="e.png"></span> <a id="c1-mention" href="${FB}/bob.example?comment_id=1">Bob Example</a> <a id="c1-tag" href="${FB}/hashtag/sky">#sky</a></div></div></span></div>
      </div></div></div></div>
      <div><div><span><div role="button" aria-label="Report this" id="c1-report"><svg viewBox="0 0 16 16"><path d="M2 2"></path></svg></div></span></div></div></div>
      <ul><li><span><div><a id="c1-time" href="${FB}/examplepage/posts/pfbid0abc?comment_id=2">1w</a></div></span></li></ul>
    </div>
    <div role="article" aria-label="Comment by Cy Example a week ago">
      <div><a href="${FB}/cy.example?comment_id=3">${PIC('c2-pic', 'role="none"')}</a></div>
      <div><div>
        <span id="c2-name"><span><a href="${FB}/cy.example?comment_id=3"><span><span dir="auto">Cy Example</span></span></a></span></span>
        <div><span dir="auto" lang="en"><div dir="auto" id="c2-text">Great shot</div></span></div>
      </div></div>
    </div>
    <div role="article" aria-label="Comment by Example Page a week ago">
      <div><a href="${FB}/examplepage?comment_id=4">${PIC('c3-pic', 'role="none"')}</a></div>
      <div><div>
        <div role="button" aria-label="View information about identity badges" id="c3-badge"><div><img alt="" src="badge.webp"><span>Author</span></div></div>
        <span id="c3-name"><span><a href="${FB}/examplepage?comment_id=4"><span><span dir="auto">Example Page</span></span></a></span></span>
        <span id="c3-verified"><div><span><div tabindex="0"><span><svg viewBox="0 0 12 12" role="img"><title>Verified account</title><path d="M7 0"></path></svg></span></div></span></div></span>
        <div><span dir="auto" lang="en"><div><div dir="auto" id="c3-text">Thanks, glad you liked it</div></div></span></div>
      </div></div>
    </div>
  </div>

  <div aria-posinset="2">
    <h3><span><a id="group-line" href="${FB}/groups/1234567890/?__cft__[0]=x">Garden Club</a></span></h3>
    <span><a id="group-author" href="${FB}/groups/1234567890/user/100000000000001/?__cft__[0]=x">Dee Example</a> · <a id="group-time" href="${FB}/groups/1234567890/posts/42/">2h</a></span>
    <a id="people" href="${FB}/people/Stew-Example/61591460262631/">Stew Example</a>
    <span><a id="profile-id" href="${FB}/profile.php?id=100000000000002">Kim Example</a> shared a memory</span>
  </div>

  <div role="article">
    <div data-ad-rendering-role="profile_name" id="related-author"><h2><span><a href="${FB}/examplepage?__cft__[0]=y">Example Page</a></span></h2></div>
    <span dir="auto"><span><a id="related-time" href="${FB}/examplepage/posts/pfbid0def">October 12 at 5:38 PM</a></span></span>
  </div>

  <div><div><div><h2 dir="auto"><span dir="auto"><span><span><div role="button" tabindex="0" id="reel-owner" aria-label="Reel Maker, see Reel Maker's profile">Reel Maker</div></span></span></span></h2></div></div>
  <div><span dir="auto"><span><span role="button" aria-label="Privacy: Public" id="reel-privacy"><img src="globe.png"></span>Public</span></span></div>
  <div><div data-type="hscroll-child"><div><div role="button" tabindex="0" id="reel-audio-button"><div><div><div><div><div><div></div><div></div></div></div></div><div><div aria-label="Reel Maker · Original audio" id="reel-audio"><div><span dir="auto">Reel Maker · Original audio</span></div><div><span dir="auto">Reel Maker · Original audio</span></div></div></div></div></div></div></div></div></div></div>
</div>
<div role="complementary">
  <a id="rc-ad" href="https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example"><img id="rc-ad-img" src="ad.jpg"><span>Shop now</span></a>
  <a id="rc-birthdays" href="${FB}/events/birthdays/"><i></i><span>Birthdays</span></a>
  <div role="button" id="rc-contact">${PIC('rc-contact-pic')}<span>Eve Example</span></div>
</div>`;

function page() {
  const win = testWindow(`${FB}/`);
  windows.push(win);
  win.document.body.innerHTML = PAGE;
  return win;
}

// What a list of selectors reaches, by id; anything without one shows up as its tag.
const reached = (win, selectors) => [...win.document.querySelectorAll(selectors.join(', '))].map((el) => el.id || `<${el.tagName.toLowerCase()}>`).sort();

test('profile pictures and cover photos blur, photos, reactions, emoji and icons stay sharp', () => {
  const win = page();
  assert.deepEqual(reached(win, PICTURES), ['c1-pic', 'c2-pic', 'c3-pic', 'cover', 'left-own-pic', 'left-shortcut-pic', 'me-pic', 'post-pic', 'rc-contact-pic']);
});

test('names blur: post authors, commenters, people named in posts and comments, page and group names', () => {
  const win = page();
  assert.deepEqual(reached(win, NAMES), [
    'c1-mention', 'c1-name', 'c2-name', 'c3-name', 'group-author', 'group-line', 'left-own', 'left-shortcut',
    'page-title', 'people', 'post-author', 'post-mention', 'profile-id', 'rc-contact', 'reel-audio', 'reel-owner', 'related-author',
  ]);
  // Everything else on the page keeps its words: comment text, timestamps, hashtags, outside
  // links, a group's own tabs, a section heading, Facebook's rows and the ad.
  for (const id of ['c1-text', 'c2-text', 'c3-text', 'c3-badge', 'c3-verified', 'c1-time', 'post-time', 'related-time', 'group-time', 'post-hashtag', 'c1-tag', 'post-out', 'group-about', 'group-media', 'photos-link', 'photos-heading', 'left-friends', 'left-groups', 'rc-ad', 'rc-birthdays', 'reel-privacy', 'reel-audio-button', 'c1-report']) {
    assert.ok(!win.document.getElementById(id).matches(NAMES.join(', ')), id);
  }
});

test('Screenshot mode is one switch, off by default, CSS only and not keyed on words', () => {
  assert.equal(screenshotMode.id, 'screenshotMode');
  assert.equal(screenshotMode.section, 'appearance');
  assert.equal(screenshotMode.default, false);
  assert.equal(screenshotMode.css, SCREENSHOT_CSS);
  assert.equal(screenshotMode.options, undefined);
  assert.equal(screenshotMode.setup, undefined, 'nothing runs, so nothing is read or sent');
  assert.ok(SCREENSHOT_CSS.startsWith(`${PICTURES.join(',\n')} { filter: blur(8px) !important; }`));
  assert.ok(SCREENSHOT_CSS.endsWith(`${NAMES.join(',\n')} { filter: blur(5px) !important; }`));
  assert.doesNotMatch(SCREENSHOT_CSS, /Comment by|see .* profile|Like:/, 'labels are in the page language');
  // Each selector parses on its own, as a browser drops a whole rule over one bad selector.
  const win = page();
  for (const selector of [...PICTURES, ...NAMES]) assert.doesNotThrow(() => win.document.querySelector(selector), selector);
});
