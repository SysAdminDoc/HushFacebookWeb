// The rules Hide parts of the page saves (src/features/appearance/part-rules.js): which links a
// rule can name, the lines it accepts, the CSS they become, and the rule a pick gets.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { describeRule, landmarkOf, matchRule, parseRule, partsCss, refusalFor, ruleFor, ruleLines, sectionPath, selectorFor } from '../src/features/appearance/part-rules.js';

// A page shaped like Facebook's: top bar, left column, main column with a feed, right column.
const PAGE = `
  <div role="banner"><a id="logo" href="/">Facebook</a>
    <div role="navigation"><a id="tab-friends" href="/friends/">Friends</a><a id="tab-video" href="https://www.facebook.com/watch/?ref=tab">Video</a></div>
  </div>
  <div role="navigation" id="left"><ul id="left-list">
    <li id="market"><div><a href="https://www.facebook.com/marketplace/?ref=bookmark"><span id="market-word">Marketplace</span></a></div></li>
    <li id="groups"><div><a href="/groups/feed/"><span>Groups</span></a></div></li>
    <li id="person"><div><a href="/someone.name"><span>Person Name</span></a></div></li>
    <li id="group"><div><a href="/groups/1234567/"><span>A group</span></a></div></li>
  </ul></div>
  <div role="main" id="main"><div id="top-of-main"><div id="stories">Stories</div></div>
    <div id="feed-wrap"><div role="feed" id="feed"><div aria-posinset="1" id="post"><a href="/marketplace/">Listing</a></div></div></div>
  </div>
  <div role="complementary"><div id="right">
    <div id="requests"><h3>Friend requests</h3><a href="/friends/requests/">See all</a><a href="/friends/requests/">Confirm</a></div>
    <div id="birthdays"><h3>Birthdays</h3><span>Someone's birthday</span></div>
  </div></div>
  <div data-hushfacebook-web="ui" id="ours"><span>ours</span></div>`;

function page(html = PAGE) {
  const win = testWindow('https://www.facebook.com/');
  // main.js stamps the running version on <html>, so the whole page sits inside that mark.
  win.document.documentElement.setAttribute('data-hushfacebook-web', '0.0.47');
  win.document.body.innerHTML = html;
  return win.document;
}

// matchRule's answer as ids, so no DOM node goes into an assert.
const ids = (line, doc) => matchRule(parseRule(line), doc).map((node) => node.id || node.tagName).sort();

test("a rule names only Facebook's own sections, never a person, group, place or another site", () => {
  for (const [href, path] of [
    ['/friends/', '/friends/'],
    ['https://www.facebook.com/marketplace/?ref=bookmark', '/marketplace/'],
    ['https://web.facebook.com/watch', '/watch/'],
    ['/groups/feed/', '/groups/feed/'],
    ['/friends/requests/?source=home', '/friends/requests/'],
    ['/', '/'],
    ['https://www.facebook.com', '/'],
  ]) assert.equal(sectionPath(href), path, href);
  for (const href of [
    '/someone.name', '/someone', '/profile.php?id=1', '/groups/1234567/', '/groups/somegroupname/', '/marketplace/nyc/',
    '/marketplace/item/123/', '/Friends/', 'https://l.facebook.com/l.php?u=x', 'https://evil.example/friends/', '//evil.example/friends/',
    'https://facebook.com/friends/', 'http://www.facebook.com/friends/', 'marketplace/', 'javascript:alert(1)', '#', '?sk=h_chr', '', null,
  ]) assert.equal(sectionPath(href), null, String(href));
});

test('a saved line is read only in its two shapes, so a backup can never carry CSS of its own', () => {
  assert.deepEqual(parseRule('main link /marketplace/ up 2'), { landmark: 'main', kind: 'link', path: '/marketplace/', up: 2 });
  assert.deepEqual(parseRule('  page at 3 1  '), { landmark: 'page', kind: 'at', steps: [3, 1] });
  assert.ok(parseRule(`dialog at ${Array(40).fill(1).join(' ')}`), 'forty steps');
  for (const line of [
    'main link /someone/ up 2', 'main link /friends/ up 13', 'main link /groups/1234567/ up 1', 'main link /friends up 1',
    'main at 0', 'main at 1  2', 'main at 1000', `main at ${Array(41).fill(1).join(' ')}`, 'region at 1',
    'main link /friends/ up 1 } body { display: none', 'main at 1, body', '[role="main"] at 1', 'MAIN at 1', '', undefined,
  ]) assert.equal(parseRule(line), null, String(line));
  assert.deepEqual(ruleLines('main at 1\nbogus\r\n\ncomplementary at 2 1\n'), ['main at 1', 'complementary at 2 1']);
});

test('each line becomes one CSS rule, a link on both hosts and relative, a place never landing on our own elements', () => {
  const css = partsCss('navigation link /marketplace/ up 2\nnot a rule\ncomplementary at 1 2');
  const rules = css.split('\n');
  assert.equal(rules.length, 2);
  assert.ok(rules.every((rule) => rule.endsWith(' { display: none !important; }')));
  for (const form of ['/marketplace/', '/marketplace', 'https://www.facebook.com/marketplace/', 'https://web.facebook.com/marketplace']) {
    assert.ok(rules[0].includes(`[role="navigation"] :has(> * > a[href="${form}"])`), form);
    assert.ok(rules[0].includes(`[role="navigation"] :has(> * > a[href^="${form}?"])`), `${form}?`);
  }
  // <html> has the attribute too (main.js), so ours is any other element that has it.
  const ours = '[data-hushfacebook-web]:not(html)';
  const place = `:not(${ours})`;
  assert.ok(rules[1].startsWith(`[role="complementary"] > :nth-child(1 of ${place}) > :nth-child(2 of ${place}):not(`), rules[1]);
  for (const rule of [rules[0], rules[1], selectorFor(parseRule('page link /friends/ up 0'))]) {
    assert.ok(rule.includes(`:not(${ours}, ${ours} *, `), 'never our own or inside it');
    assert.ok(rule.includes(':not(:has([role="feed"], [aria-posinset]:not([role]), [role="article"], [role="main"]))'), 'never what holds a post');
    for (const post of ['[role="feed"]', '[aria-posinset]:not([role])', '[role="article"]']) assert.ok(rule.includes(`, ${post} *`), `never inside ${post}`);
  }
  assert.ok(selectorFor(parseRule('page link /friends/ up 0')).startsWith('body a[href="/friends/"]:not('));
  assert.equal(partsCss(''), '');
  assert.equal(partsCss(undefined), '');
});

test('the matcher finds what the CSS would: inside the landmark, that many levels up, never our own', () => {
  const doc = page();
  assert.deepEqual(ids('navigation link /marketplace/ up 2', doc), ['market'], 'not the post in the main column');
  assert.deepEqual(ids('main link /marketplace/ up 1', doc), [], 'never a post, even one the rule reaches');
  assert.deepEqual(ids('navigation link /friends/ up 0', doc), ['tab-friends'], 'the top bar has a navigation inside');
  assert.deepEqual(ids('page link /friends/ up 0', doc), ['tab-friends'], 'the whole page');
  assert.deepEqual(ids('complementary at 1 2', doc), ['birthdays']);
  assert.deepEqual(ids('page at 5', doc), [], 'four of the five things in the page are Facebook\'s, so there is no 5th');
  assert.deepEqual(ids('complementary at 1 9', doc), []);

  // A section link in the main column, outside the feed, is found like any other.
  const side = page('<div role="main"><div id="side"><a href="/marketplace/">Marketplace</a></div><div role="feed"><div aria-posinset="1">x</div></div></div>');
  assert.deepEqual(ids('main link /marketplace/ up 1', side), ['side']);
  // A line from a backup can point anywhere, but never at the main column or what holds it.
  const big = page('<div id="a">x</div><div role="main" id="m"><div>y</div></div><div id="outer"><div role="main"><div>z</div></div></div>');
  assert.deepEqual(ids('page at 1', big), ['a']);
  assert.deepEqual(ids('page at 2', big), [], 'the main column');
  assert.deepEqual(ids('page at 3', big), [], 'what holds a main column');
  // Nor at the script's own, by a link inside it.
  const own = page('<div data-hushfacebook-web="ui"><div id="o"><a href="/friends/">Friends</a></div></div><div id="f"><a href="/friends/">Friends</a></div>');
  assert.deepEqual(ids('page link /friends/ up 1', own), ['f']);
});

test('a pick becomes a rule that hides it and nothing else, by a section link when it can', () => {
  const doc = page();
  const pick = (id) => ruleFor(doc.getElementById(id), doc);
  assert.deepEqual(pick('market'), { line: 'navigation link /marketplace/ up 2' });
  assert.deepEqual(pick('requests'), { line: 'complementary link /friends/requests/ up 1' }, 'both its links point at it');
  assert.deepEqual(pick('right'), { line: 'complementary link /friends/requests/ up 2' });
  assert.deepEqual(pick('tab-friends'), { line: 'banner link /friends/ up 0' }, 'the outermost landmark names it');
  assert.deepEqual(pick('birthdays'), { line: 'complementary at 1 2' }, 'no section link, so its place');
  assert.deepEqual(pick('person'), { line: 'navigation at 1 3' }, "a person's link is never used");
  assert.deepEqual(pick('group'), { line: 'navigation at 1 4' }, "nor a group's");
  assert.deepEqual(pick('market-word'), { line: 'navigation at 1 1 1 1 1' });
  assert.deepEqual(pick('top-of-main'), { line: 'main at 1' });
  for (const id of ['market', 'requests', 'right', 'tab-friends', 'birthdays', 'person', 'top-of-main']) {
    assert.deepEqual(ids(pick(id).line, doc), [id], `${id} alone`);
  }
});

test('the same link twice falls back to its place, and a place two dialogs share is refused', () => {
  const doc = page(`<div role="navigation"><div id="one"><a href="/groups/feed/">a</a></div><div id="two"><a href="/groups/feed/">b</a></div></div>
    <div role="dialog"><div id="first">x</div></div><div role="dialog"><div>y</div></div>`);
  assert.deepEqual(ruleFor(doc.getElementById('one'), doc), { line: 'navigation at 1' });
  assert.deepEqual(ruleFor(doc.getElementById('first'), doc), { refused: 'unclear' });
});

test("posts, the feed and what holds them are refused, and so are the page, the main column and the script's own", () => {
  const doc = page();
  const refused = (id) => ruleFor(doc.getElementById(id), doc).refused;
  for (const id of ['post', 'feed', 'feed-wrap']) assert.equal(refused(id), 'feed', id);
  assert.equal(refused('main'), 'feed', 'the main column holds the feed');
  const plain = page('<div id="outer"><div role="main" id="m"><div>x</div></div></div>');
  assert.equal(ruleFor(plain.getElementById('m'), plain).refused, 'big', 'a main column without a feed is still too much');
  assert.equal(ruleFor(plain.getElementById('outer'), plain).refused, 'big');
  assert.equal(ruleFor(doc.body, doc).refused, 'big');
  assert.equal(ruleFor(doc.documentElement, doc).refused, 'big');
  assert.equal(refused('ours'), 'ours');
  assert.equal(refusalFor(doc.getElementById('ours').firstElementChild, doc), 'ours');
  assert.equal(refusalFor(doc.createTextNode('x'), doc), 'big', 'a text node outside the page, which has no closest()');
  assert.equal(refusalFor(doc.createElement('div').attachShadow({ mode: 'open' }), doc), 'big', 'and a shadow root');
  // A text or comment node on the page goes by the element it sits in.
  assert.equal(refusalFor(doc.querySelector('#ours span').firstChild, doc), 'ours');
  assert.equal(refusalFor(doc.getElementById('post').firstChild.firstChild, doc), 'feed');
  const words = doc.querySelector('#birthdays span');
  words.append(doc.createComment('x'));
  assert.equal(refusalFor(words.lastChild, doc), null);
  assert.equal(ruleFor(words.firstChild, doc).line, ruleFor(words, doc).line, 'and gets the rule its element would');
  const article = page('<div role="main"><div id="wrap"><div role="article"><span id="in">x</span></div></div></div>');
  assert.equal(ruleFor(article.getElementById('in'), article).refused, 'feed', 'a permalink post too');
  assert.equal(ruleFor(article.getElementById('wrap'), article).refused, 'feed');
});

test('no rule for anything on the page holds words, names or ids from it', () => {
  const doc = page();
  for (const node of doc.querySelectorAll('body *')) {
    const { line } = ruleFor(node, doc);
    if (!line) continue;
    assert.ok(parseRule(line), line);
    assert.doesNotMatch(line, /someone|person|name|1234567|ref=|facebook\.com|Friend requests|Birthdays/i, line);
  }
});

test('a saved rule never hides posts Facebook puts there later, in a dialog, inside a part, or a part holding them', () => {
  const doc = page();
  // Picked before any post was there.
  const top = ruleFor(doc.getElementById('top-of-main'), doc).line;
  const watch = ruleFor(doc.getElementById('tab-video'), doc).line;
  assert.equal(top, 'main at 1');
  // Then Facebook moves the feed into that place, a post links to Video, and a post opens in a dialog.
  doc.getElementById('top-of-main').append(doc.getElementById('feed'));
  doc.getElementById('post').insertAdjacentHTML('beforeend', '<div id="in-post"><a href="https://www.facebook.com/watch/?v=222&ref=x">a video</a></div>');
  doc.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div id="d1"><div role="article" id="opened"><a href="/watch/">v</a></div></div></div>');
  assert.deepEqual(ids(top, doc), [], 'the place now holds the feed');
  assert.deepEqual(ids('main link /watch/ up 1', doc), [], 'a link inside a post');
  assert.deepEqual(ids('dialog at 1', doc), [], 'a dialog part holding a post');
  assert.deepEqual(ids('dialog link /watch/ up 0', doc), [], 'a link inside a post in a dialog');
  assert.deepEqual(ids(watch, doc), ['tab-video'], 'the top bar tab still goes');
});

test("a place counts only Facebook's elements, so the script's own never moves it", () => {
  const doc = page('<div data-hushfacebook-web="ui"></div><div id="a"><div>x</div></div><div id="b"><div id="b1">y</div><div id="b2">z</div></div>');
  const line = ruleFor(doc.getElementById('b2'), doc).line;
  assert.equal(line, 'page at 2 2', "the settings button's host isn't counted");
  doc.body.insertAdjacentHTML('afterbegin', '<div data-hushfacebook-web="download"></div>');
  doc.getElementById('b1').insertAdjacentHTML('beforebegin', '<div data-hushfacebook-web="download"></div>');
  assert.deepEqual(ids(line, doc), ['b2'], 'still the same part after the script adds two more of its own');
  assert.equal(ruleFor(doc.getElementById('b2'), doc).line, line, 'and a pick now gets the same line');
});

test('a rule keeps to the kind of page it was picked on, except in the top bar', () => {
  const doc = page();
  doc.documentElement.dataset.hfwRoute = 'home';
  const pick = (id) => ruleFor(doc.getElementById(id), doc).line;
  assert.equal(pick('requests'), 'complementary link /friends/requests/ up 1 on home');
  assert.equal(pick('birthdays'), 'complementary at 1 2 on home');
  assert.equal(pick('tab-friends'), 'banner link /friends/ up 0', 'the top bar is the same on every page');
  assert.deepEqual(parseRule('complementary at 1 2 on home'), { landmark: 'complementary', kind: 'at', steps: [1, 2], route: 'home' });
  for (const bad of ['complementary at 1 2 on nowhere', 'complementary at 1 2 on Home', 'complementary at 1 2 on', 'main at 1 on home on home']) {
    assert.equal(parseRule(bad), null, bad);
  }
  assert.ok(selectorFor(parseRule('complementary at 1 2 on home')).startsWith('html[data-hfw-route="home"] [role="complementary"] > '));
  assert.ok(selectorFor(parseRule('page link /friends/ up 0 on groups')).split(':not(')[0] === 'html[data-hfw-route="groups"] body a[href="/friends/"]');
  assert.deepEqual(ids('complementary at 1 2 on home', doc), ['birthdays']);
  doc.documentElement.dataset.hfwRoute = 'groups';
  assert.deepEqual(ids('complementary at 1 2 on home', doc), [], 'not on a group');
  assert.deepEqual(ids('banner link /friends/ up 0', doc), ['tab-friends']);
  assert.equal(describeRule('complementary link /friends/requests/ up 1 on home'), 'The part with a link to /friends/requests/ in the right column, on Home');
  assert.equal(describeRule('navigation at 1 3 on profile'), 'A part of the left column on profiles and Pages, found by its place in it');
});

test('landmarks and the words for each saved part', () => {
  const doc = page();
  assert.equal(landmarkOf(doc.getElementById('tab-video'), doc).name, 'banner');
  assert.equal(landmarkOf(doc.getElementById('birthdays'), doc).name, 'complementary');
  assert.equal(landmarkOf(doc.getElementById('ours'), doc).name, 'page');
  assert.equal(describeRule('navigation link /marketplace/ up 2'), 'The part with a link to /marketplace/ in the left column');
  assert.equal(describeRule('banner link / up 1'), 'The part with a link to / in the top bar');
  assert.equal(describeRule('complementary at 1 2'), 'A part of the right column, found by its place in it');
  assert.equal(describeRule('page at 2'), 'A part of the page, found by its place in it');
  assert.equal(describeRule('dialog at 1'), 'A part of a dialog or menu, found by its place in it');
  assert.equal(describeRule('nonsense'), 'nonsense');
});
