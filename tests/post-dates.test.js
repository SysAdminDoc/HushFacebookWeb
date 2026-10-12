// Show full post dates, against feed answers captured from facebook.com (scrubbed, so their
// times are stand-ins) and post headers as drawn live on 2026-10-11 (captures/2026-10-11-run23):
// the time link opens in a new tab, has no rel and no label, and shows "3h" until pointed at.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import keepPostDates, { DATE_MARK, MARKERS, createTimeBook, formatTime, indexTimes, showDate, timeLinkOf } from '../src/features/feed/post-dates.js';
import { storyKeys } from '../src/core/seen-keys.js';
import { rulesFor } from '../src/core/net/payload.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html) {
  const win = new Window({ url: 'https://www.facebook.com/' });
  windows.push(win);
  win.document.documentElement.lang = 'en';
  win.document.body.innerHTML = html;
  return win;
}

// A post header as drawn live: the group's avatar (labeled), the author's name, the time link
// (target, no rel), the Hide post button (labeled), then the post's photo and the hidden copies
// of its link out (rel, or inside an <object>).
// row: the time sits in the header row the way Feeds and the groups feed draw it (run 68), a
// box as wide as the time inside a wrapping flex row, then the dot and the audience icon.
const timeLink = (time) => `<span><a href="${time}" role="link" tabindex="0" target="_blank"><span>3h</span></a></span>`;
const post = ({ photo = '969545875', words = '', time = '?__cft__[0]=AZx', row = false } = {}) => `
<div aria-posinset="1">
  <a aria-label="Venice Beach Florida" href="/groups/12345678/?__cft__[0]=AZx" role="link" tabindex="0"><svg></svg></a>
  <h3><span><a href="/groups/12345678/" role="link" tabindex="0">Venice Beach Florida</a></span></h3>
  <span><span><a href="/groups/12345678/user/87654321/?__cft__[0]=AZx" role="link" tabindex="0">Sun Fiesta</a></span></span>
  ${row
    ? `<div style="display: flex; flex-wrap: wrap"><span style="display: block"><span style="display: block">${timeLink(time)}</span></span><span aria-hidden="true"> · </span><span><svg></svg></span></div>`
    : `<span><span>${timeLink(time)}</span></span>`}
  <a aria-label="Hide post by Sun Fiesta" href="#" role="link" tabindex="0"></a>
  <div data-ad-rendering-role="story_message"><div>${words}<a href="https://example.com/" target="_blank" rel="nofollow noopener">example.com</a></div></div>
  ${photo ? `<a href="https://www.facebook.com/photo/?fbid=${photo}&amp;set=a.1" role="link" tabindex="0"></a>` : ''}
  <a href="?__cft__[0]=AZx" rel="nofollow noopener" role="link" tabindex="-1" target="_blank"></a>
  <object><a href="?__cft__[0]=AZx" role="link" target="_blank"></a></object>
</div>`;

test("feed answers give each story's time by its photos and videos and its first words", async () => {
  const [first, second] = (await fixtureLines('CometNewsFeedPaginationQuery.jsonl')).map(parseLine);
  const book = createTimeBook();
  assert.equal(indexTimes(first, book.remember), 1);
  assert.equal(indexTimes(second, book.remember), 1);
  assert.equal(book.timeOf(['t:icyx2a1hg013g']), 698502477);
  assert.equal(book.timeOf(['m:969545875']), 219816548);
  assert.equal(book.timeOf(['t:offogx1qedj27']), 219816548);
  assert.equal(book.timeOf(['m:1', 't:none']), null);
  // The first screen of Home, inline in the page, nested deep in its require blocks.
  const inline = (await fixtureLines('home-data-sjs.jsonl')).map(parseLine);
  const fromPage = createTimeBook();
  assert.equal(inline.reduce((n, doc) => n + indexTimes(doc, fromPage.remember), 0), 2);
  assert.equal(fromPage.timeOf(['m:238212940']), 406433511);
  for (const line of await fixtureLines('CometNewsFeedPaginationQuery.jsonl')) {
    if (line.includes('"creation_time"')) assert.ok(MARKERS.some((marker) => line.includes(marker)), 'a line with a story has the marker');
    else assert.equal(indexTimes(parseLine(line), () => {}), 0);
  }
});

test("a shared post's own time is the one kept, not its original's", () => {
  const original = 'The original post had plenty of words in it to be keyed by';
  const share = {
    __typename: 'Story',
    creation_time: 1760221440,
    comet_sections: { content: { story: { attached_story: { message: { text: original } } } } },
    attached_story: { __typename: 'Story', creation_time: 1700000000, comet_sections: {}, message: { text: original } },
  };
  const book = createTimeBook();
  assert.equal(indexTimes({ data: { node: share } }, book.remember), 1);
  assert.equal(book.timeOf(storyKeys(share)), 1760221440);
});

test("a key two stories give different times dates neither by it, so no post shows another's date", () => {
  const words = 'The original post had plenty of words in it to be keyed by';
  const photo = { attachments: [{ media: { __typename: 'Photo', id: '969545875' } }] };
  const story = (seconds, content) => ({ __typename: 'Story', creation_time: seconds, comet_sections: { content: { story: content } } });
  const original = story(1700000000, { message: { text: words }, ...photo });
  const share = story(1760221440, { message: { text: 'Look at this one, friends, it is worth a read today' }, attached_story: { message: { text: words }, ...photo } });
  const bareShare = story(1760300000, { attached_story: { message: { text: words }, ...photo } });
  for (const order of [[original, share], [share, original]]) {
    const book = createTimeBook();
    for (const node of order) indexTimes({ data: { node } }, book.remember);
    // The photo is in both, so each is dated by its own words.
    assert.equal(book.timeOf(['m:969545875']), null);
    assert.equal(book.timeOf(storyKeys(original)), 1700000000);
    assert.equal(book.timeOf(storyKeys(share)), 1760221440);
    // A share with no words of its own has every key of the original: neither gets a date.
    indexTimes({ data: { node: bareShare } }, book.remember);
    assert.equal(book.timeOf(storyKeys(original)), null);
    assert.equal(book.timeOf(storyKeys(bareShare)), null);
    assert.equal(book.timeOf(storyKeys(share)), 1760221440);
  }
  // The same story in two answers keeps its time.
  const again = createTimeBook();
  indexTimes({ data: { node: original } }, again.remember);
  indexTimes({ data: { node: original } }, again.remember);
  assert.equal(again.timeOf(storyKeys(original)), 1700000000);
});

test('a full book forgets the key seen longest ago, and a shared key stays shared while dated ones come and go', () => {
  const book = createTimeBook();
  book.remember('shared', 1700000000);
  book.remember('shared', 1760000000);
  book.remember('first', 1700000001);
  // The shared key takes no room among the dated ones, so 4000 dated keys fill the book.
  for (let i = 0; i < 3999; i++) book.remember(`k${i}`, 1700000100 + i);
  book.remember('first', 1700000001); // seen again, so it's no longer the oldest
  book.remember('new', 1760000100);
  assert.equal(book.timeOf(['k0']), null, 'the oldest key with a time went');
  assert.equal(book.timeOf(['first']), 1700000001);
  assert.equal(book.timeOf(['k1']), 1700000101);
  assert.equal(book.timeOf(['new']), 1760000100);
  // Long after, a third story with the shared key still dates no one by it.
  for (let i = 0; i < 5000; i++) book.remember(`later${i}`, 1760001000 + i);
  book.remember('shared', 1761000000);
  assert.equal(book.timeOf(['shared']), null);
});

test('shared keys never crowd dated ones out of the book', () => {
  const book = createTimeBook();
  for (let i = 0; i < 3990; i++) {
    book.remember(`shared${i}`, 1700000000);
    book.remember(`shared${i}`, 1760000000);
  }
  for (let i = 0; i < 4000; i++) book.remember(`dated${i}`, 1700000100 + i);
  assert.equal(book.timeOf(['dated0']), 1700000100);
  assert.equal(book.timeOf(['dated3999']), 1700004099);
  assert.equal(book.timeOf(['shared0', 'dated5']), 1700000105, 'a shared key is passed over for the next one');
  // Shared keys are capped too, the ones seen longest ago going first.
  const small = createTimeBook({ max: 3 });
  for (const key of ['a', 'b', 'c', 'd']) {
    small.remember(key, 1);
    small.remember(key, 2);
  }
  small.remember('a', 3);
  assert.equal(small.timeOf(['a']), 3, 'a forgotten shared key can be dated again');
  assert.equal(small.timeOf(['d']), null);
});

test('a key the book let go comes back shared when another story brings it with another time', () => {
  const book = createTimeBook({ max: 3 });
  book.remember('own', 1700000000);
  book.remember('again', 1700000500);
  for (const key of ['x', 'y', 'z']) book.remember(key, 1750000000);
  assert.equal(book.timeOf(['own']), null, 'let go');
  // A later story with the same words: the first post must not take its date.
  book.remember('own', 1760000000);
  assert.equal(book.timeOf(['own']), null);
  // The same story brought back is dated again.
  book.remember('again', 1700000500);
  assert.equal(book.timeOf(['again']), 1700000500);
});

test('the time link is the header link that opens in a new tab, before and after Facebook fills it in', () => {
  const win = page(post());
  const element = win.document.querySelector('[aria-posinset]');
  assert.equal(timeLinkOf(element)?.textContent, '3h');
  const filled = page(post({ time: 'https://www.facebook.com/groups/12345678/?multi_permalinks=99999999' }));
  assert.equal(timeLinkOf(filled.document.querySelector('[aria-posinset]'))?.textContent, '3h');
  const bare = page('<div aria-posinset="1"><a href="/x" role="link">Name</a></div>');
  assert.equal(timeLinkOf(bare.document.querySelector('[aria-posinset]')), null);
});

test('the date goes right after the time link once, and follows a change of story', () => {
  const win = page(post());
  const doc = win.document;
  const element = doc.querySelector('[aria-posinset]');
  assert.equal(showDate(doc, element, 1760221440, 'en-US'), true);
  assert.equal(showDate(doc, element, 1760221440, 'en-US'), true);
  const marks = element.querySelectorAll(`[${DATE_MARK}]`);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].previousElementSibling, timeLinkOf(element));
  assert.match(marks[0].textContent, /^· Oct 1[12], 2025, /);
  showDate(doc, element, 1700000000, 'en-US');
  assert.match(element.querySelector(`[${DATE_MARK}]`).textContent, /Nov 1[45], 2023/);
  // Facebook drew the header again somewhere else: the old date goes.
  const link = timeLinkOf(element);
  link.parentElement.append(doc.createElement('i'));
  link.parentElement.append(link);
  assert.equal(showDate(doc, element, 1700000000, 'en-US'), true);
  assert.equal(element.querySelectorAll(`[${DATE_MARK}]`).length, 1);
  assert.equal(showDate(doc, element, null, 'en-US'), false, 'no time known yet');
});

test("in Facebook's header row the date is an item of its own after the time's box, so nothing lands on it", () => {
  const win = page(post({ row: true }));
  const doc = win.document;
  const element = doc.querySelector('[aria-posinset]');
  const box = timeLinkOf(element).parentElement.parentElement.parentElement;
  assert.equal(showDate(doc, element, 1760221440, 'en-US'), true);
  const mark = element.querySelector(`[${DATE_MARK}]`);
  assert.ok(mark.previousElementSibling === box, "right after the time's box");
  assert.equal(mark.parentElement.style.display, 'flex', 'an item of the row');
  assert.equal(mark.nextElementSibling.textContent.trim(), '·', "Facebook's dot and icon come after it");
  assert.ok(!box.querySelector(`[${DATE_MARK}]`), "nothing inside the time's box");
  assert.equal(showDate(doc, element, 1700000000, 'en-US'), true);
  assert.equal(element.querySelectorAll(`[${DATE_MARK}]`).length, 1);
  assert.match(element.querySelector(`[${DATE_MARK}]`).textContent, /Nov 1[45], 2023/);
});

test('a date is written in the page language, or the browser default when that one is unknown', () => {
  assert.match(formatTime(1760221440, 'en-US'), /2025/);
  assert.match(formatTime(1760221440, 'de'), /2025/);
  assert.match(formatTime(1760221440, 'not a language!'), /2025/);
});

test('the feature reads the data without changing it and dates the posts it can match', async () => {
  const win = page(post() + post({ photo: '' }).replace('aria-posinset="1"', 'aria-posinset="2"'));
  const doc = win.document;
  const rules = [];
  const rows = [];
  const subscribers = [];
  const listeners = {};
  const records = [...doc.querySelectorAll('[aria-posinset]')].map((element) => ({ element }));
  const posts = {
    on: (type, fn) => {
      (listeners[type] ??= []).push(fn);
      return () => {};
    },
    current: () => records,
  };
  let on = true;
  keepPostDates.setup({
    doc,
    net: { transformResponses: (rule) => rules.push(rule) },
    posts,
    enabled: () => on,
    settings: { subscribe: (fn) => subscribers.push(fn) },
    diagnostics: { add: (label, read) => rows.push([label, read]), changed() {} },
  });
  const [rule] = rules;
  assert.equal(rule.match({ transport: 'json-parse' }), true);
  assert.equal(rule.match({ transport: 'fetch' }), false);
  const [, line] = await fixtureLines('CometNewsFeedPaginationQuery.jsonl');
  assert.equal(rulesFor(line, [rule]).length, 1);
  const data = parseLine(line);
  const before = structuredClone(data);
  assert.equal(rule.transform(data), false);
  assert.deepEqual(data, before, 'only read');
  for (const record of records) listeners['post/add'].forEach((fn) => fn(record));
  const [dated, unknown] = records.map((record) => record.element);
  assert.equal(dated.querySelectorAll(`[${DATE_MARK}]`).length, 1);
  assert.equal(dated.querySelector(`[${DATE_MARK}]`).getAttribute(DATE_MARK), '219816548');
  assert.equal(unknown.querySelector(`[${DATE_MARK}]`), null);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Post dates shown', '1']]);
  on = false;
  subscribers.forEach((fn) => fn());
  assert.equal(doc.querySelector(`[${DATE_MARK}]`), null, 'switched off, the dates go');
  on = true;
  subscribers.forEach((fn) => fn());
  assert.equal(dated.querySelectorAll(`[${DATE_MARK}]`).length, 1, 'and come back');
  assert.equal(keepPostDates.default, false);
  assert.equal(keepPostDates.needsPage, true);
});
