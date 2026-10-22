// Hide counts, against posts and comments shaped like Facebook's (live 2026-10-22 on Home and a
// post page).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import hideCounts, { MARK, countsCss, createCountHider, markCounts } from '../src/features/feed/hide-counts.js';
import { features } from '../src/features/index.js';
import { createDiagnostics } from '../src/core/diagnostics.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(body) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = body;
  return win;
}

const icon = '<span><i data-visualcompletion="css-img"></i></span><div></div>';
// One of the post's buttons, with its count beside the icon when it has one.
const action = (label, count) => `<div role="button" aria-label="${label}" tabindex="0"><div><div>${icon}</div>${count ? `<div><span>${count}</span></div>` : ''}</div><div role="none" data-visualcompletion="ignore"></div></div>`;
const react = '<div role="button" aria-label="React" tabindex="0"><svg></svg></div>';
// Facebook's reaction pictures are small svg data pictures, people's come from its photo servers.
const picture = (size, src = 'data:image/svg+xml,%3Csvg%3E') => `<img height="${size}" role="presentation" src="${src}" width="${size}">`;
const photo = (name) => `<img src="https://scontent.xx.fbcdn.net/v/${name}.jpg" alt="">`;
const reaction = (label) => `<span><span><span><span><div role="button" aria-label="${label}" tabindex="0">${picture(18)}</div></span></span></span></span>`;
const preview = (...labels) => `<div><span role="toolbar" aria-label="See who reacted to this">${labels.map(reaction).join('')}</span></div>`;
const row = ({ like, comment, share, reactions = [] } = {}) => `<div data-visualcompletion="ignore-dynamic"><div><div><div><div><div><div>
  <div>${action('Like', like)}${react}</div>
  <div>${action('Leave a comment', comment)}</div>
  <div>${action('Share, send this to friends or post it on your profile.', share)}</div>
  ${reactions.length ? preview(...reactions) : '<div></div>'}
</div></div></div></div></div></div></div>`;
const post = (n, counts, rest = '') => `<div aria-posinset="${n}"><h4><a href="/page">A Page</a></h4><a href="/page/posts/${n}">2h</a><div>Garden photos</div>${row(counts)}${rest}</div>`;
const bubble = (label, pictures = 2, src = undefined) => `<div><span><div role="button" aria-label="${label}" tabindex="0"><div><div>${`<span>${picture(16, src)}</span>`.repeat(pictures)}</div></div><div role="none"></div></div></span></div>`;
const comment = (extra) => `<div role="article" aria-label="Comment by Pat Lee a week ago" tabindex="-1"><a href="/pat">Pat Lee</a><div>Lovely</div>${extra}
  <div role="button" tabindex="0">Like</div><div role="button" tabindex="0">Reply</div><a href="/x?comment_id=1">1w</a></div>`;

const kinds = (doc) => [...doc.querySelectorAll(`[${MARK}]`)].map((node) => `${node.getAttribute(MARK)}:${node.textContent.trim() || node.querySelector('[aria-label]')?.getAttribute('aria-label')}`);

test("a post's counts, its reaction preview and a comment's reactions are each marked, and the buttons stay", () => {
  const win = page(post(1, { like: '47.8K', comment: '1.1K', share: '22K', reactions: ['Like: 31K people', 'Love: 14K people'] }, comment(bubble('151 reactions; see who reacted to this'))));
  assert.deepEqual(markCounts(win.document), { post: 3, preview: 1, comment: 1 });
  assert.deepEqual(kinds(win.document), ['post:47.8K', 'post:1.1K', 'post:22K', 'preview:See who reacted to this', 'comment:151 reactions; see who reacted to this']);
  const like = win.document.querySelector('[aria-label="Like"]');
  assert.ok(!like.hasAttribute(MARK) && like.querySelector('i'), 'the button and its icon stay');
  const count = like.querySelector(`[${MARK}]`);
  assert.ok(count.textContent === '47.8K' && !count.querySelector('i') && count.parentElement.querySelector('i'), 'only the count beside the icon is marked');
  assert.ok(win.document.querySelector('[role="toolbar"]').parentElement.hasAttribute(MARK), "the preview takes its wrapper with it");
  const before = kinds(win.document);
  assert.deepEqual(markCounts(win.document), { post: 3, preview: 1, comment: 1 }, 'a second pass changes nothing');
  assert.deepEqual(kinds(win.document), before);
});

test('any language: counts are digits with a short word after or before them', () => {
  const win = page(post(1, { like: '1,2 mil', comment: '2,3 tys.', share: '1.2万', reactions: ['Me gusta: 31 mil personas'] })
    + post(2, { like: '١٢', comment: '3\u00a0k', share: '1\u202f234' }, comment(bubble('151 reacciones; ver quién reaccionó a esto', 3)))
    + post(3, { like: '١٫٢ ألف', comment: '١٬٢٣٤', share: '\u200f12' })
    + post(4, { like: '\u20681.2K\u2069', comment: 'elfu 1.2' }, comment(bubble('12 reactions', 1, 'https://static.xx.fbcdn.net/rsrc.php/v3/like.png'))));
  assert.deepEqual(markCounts(win.document), { post: 11, preview: 1, comment: 2 });
});

test("a post without counts, the top bar and left column, a grid of buttons, a video's controls, links, and comments' own buttons stay", () => {
  const win = page(`<div role="banner"><div>${action('Notifications', '3')}${action('Messenger', '2')}${action('Menu', '9+')}</div></div>
    <div role="navigation"><div>${action('Groups', '5')}${action('Feeds', '12')}${action('Events', '1')}</div></div>
    ${post(1, {})}
    <div aria-posinset="2">${action('Actions for this post')}<div><div><div>${action('Go live', '3')}</div><div>${action('Photo', '')}</div></div></div><a href="/p/2"><span>2h</span></a></div>
    ${post(4, { like: '3 friends liked this', comment: '2 shared it' })}
    ${post(3, { like: 'Like' }, comment(`${bubble('Reply to Pat')}<div role="button" aria-label="See 3 replies" tabindex="0"><svg></svg>3 replies</div>
      <a role="link" aria-label="Photo 3 of 5" href="/photo"><img src="p.png"></a><div role="button" aria-label="4 photos"><img src="a.png"><img src="b.png"><img src="c.png"><img src="d.png"></div>
      <div role="button" aria-label="2 photos" tabindex="0"><a href="/photo/1"><img src="a.png"></a><a href="/photo/2"><img src="b.png"></a></div>
      <div role="button" aria-label="3 replies" tabindex="0">${photo('pat')}</div><div role="button" aria-label="Photo 1 of 2" tabindex="0">${photo('garden')}</div>
      <div role="button" aria-label="Play GIF, 3 seconds" tabindex="0">${picture(16, 'data:image/gif;base64,R0lG')}<svg></svg></div>`))}
    <div role="dialog"><div>${['Groups', 'Pages', 'Events', 'Saved', 'Memories', 'Feeds'].map((label) => action(label, '2')).join('')}</div></div>
    ${comment('<div role="button" aria-label="Pat Lee replied · 3 Replies" tabindex="0"><img src="pat.png"><span>Pat Lee replied · 3 Replies</span></div>')}
    <div role="article" aria-label="Comment by Pat"><span role="toolbar"><div role="button" aria-label="Bold"><svg></svg></div></span></div>`);
  assert.deepEqual(markCounts(win.document), { post: 0, preview: 0, comment: 0 });
  assert.equal(win.document.querySelectorAll(`[${MARK}]`).length, 0);
  const player = page(`<div aria-posinset="5"><div><video></video><div>${action('Play')}${action('Quality', '720p')}${action('Volume')}</div></div></div>`);
  assert.deepEqual(markCounts(player.document), { post: 0, preview: 0, comment: 0 }, "a video player's controls");
});

test("a comment's reactions never take the words written beside them", () => {
  const win = page(`<div role="article" aria-label="Comment by Pat Lee"><div><div>Lovely garden<span><div role="button" aria-label="4 reactions; see who reacted to this" tabindex="0">${picture(16)}</div></span></div></div></div>`);
  assert.deepEqual(markCounts(win.document), { post: 0, preview: 0, comment: 1 });
  const marked = win.document.querySelector(`[${MARK}]`);
  assert.equal(marked.tagName, 'SPAN');
  assert.ok(!marked.textContent.includes('Lovely'));
});

test('a picture drawn beside a count stays out of the mark', () => {
  const like = `<div role="button" aria-label="Like" tabindex="0"><div><div>${icon}</div><div><div style="background-image: url(love.png)"></div><span>12</span></div></div></div>`;
  const win = page(`<div><div>${like}${react}</div><div>${action('Leave a comment')}</div><div>${action('Share')}</div></div>`);
  assert.deepEqual(markCounts(win.document), { post: 1, preview: 0, comment: 0 });
  assert.equal(win.document.querySelector(`[${MARK}]`).tagName, 'SPAN');
});

test('a mark comes off when Facebook redraws the node with something else in it', () => {
  const win = page(post(1, { like: '12', comment: '3' }) + '<div id="other" data-hfw-count="post">Your story</div>');
  assert.deepEqual(markCounts(win.document), { post: 2, preview: 0, comment: 0 });
  assert.ok(!win.document.querySelector('#other').hasAttribute(MARK), 'a mark on something that holds no count comes off');
  [...win.document.querySelectorAll('[aria-label="Like"] span')].find((span) => span.textContent === '12').textContent = 'Like';
  assert.deepEqual(markCounts(win.document), { post: 1, preview: 0, comment: 0 });
  assert.deepEqual(kinds(win.document), ['post:3']);
});

test('each choice hides its own kind through the style', () => {
  const values = { 'hideCounts.posts': true, 'hideCounts.preview': false, 'hideCounts.comments': true };
  const css = countsCss((key) => values[key]);
  assert.match(css, /\[data-hfw-count="post"\],\n\[data-hfw-count="comment"\] \{ display: none !important; \}/);
  assert.ok(!css.includes('preview'));
  assert.equal(countsCss(() => false), '', 'nothing when every choice is off');
  assert.deepEqual(hideCounts.options.map(({ key, default: on }) => [key, on]), [['posts', true], ['preview', true], ['comments', true]]);
});

test('the switch starts off, and marks counts drawn later and counts that show up on a post', async () => {
  assert.equal(hideCounts.default, false);
  assert.equal(hideCounts.section, 'feed');
  assert.ok(features.includes(hideCounts));
  assert.ok(!hideCounts.needsPage, 'works in content mode');
  const win = page('');
  let on = false;
  const timers = [];
  const hider = createCountHider({ doc: win.document, enabled: () => on, setTimer: (fn) => timers.push(fn) });
  hider.start();
  win.document.body.innerHTML = post(1, { like: '12', comment: '3', share: '1' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timers.length, 0, 'nothing while off');
  hider.sync();
  assert.deepEqual(hider.marked(), { post: 0, preview: 0, comment: 0 }, 'a sync while off marks nothing');
  on = true;
  win.document.body.insertAdjacentHTML('beforeend', post(2, { reactions: ['Like: 1 person'] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  timers.splice(0).forEach((run) => run());
  assert.deepEqual(hider.marked(), { post: 3, preview: 1, comment: 0 });
  // Your Like on a post with none: Facebook adds the count beside the icon.
  win.document.querySelectorAll('[aria-label="Like"]')[1].firstElementChild.insertAdjacentHTML('beforeend', '<div><span>1</span></div>');
  await new Promise((resolve) => setTimeout(resolve, 0));
  timers.splice(0).forEach((run) => run());
  assert.deepEqual(hider.marked(), { post: 4, preview: 1, comment: 0 });
});

test('Diagnostics counts what is hidden on the page now, by kind', () => {
  const win = page(post(1, { like: '5', comment: '2' }, comment(bubble('4 reactions; see who reacted to this'))) + post(2, { like: '7' }));
  const diagnostics = createDiagnostics();
  hideCounts.setup({ doc: win.document, diagnostics, enabled: () => true });
  const value = () => diagnostics.rows().find(({ label }) => label === 'Post counts hidden');
  assert.deepEqual({ value: value().value, shareable: value().shareable }, { value: 'posts 3, previews 0, comments 1', shareable: true });
  win.document.querySelector('[aria-posinset="1"]').remove();
  assert.equal(value().value, 'posts 1, previews 0, comments 0', 'a post scrolled away takes its counts with it');
});
