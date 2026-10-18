// The page-side ad check against 100 real posts that aren't ads: 40 from Home, 35 from the
// groups feed and 25 from a post search, captured live on 2026-10-11 (captures/2026-10-11-run31,
// the script running, nothing marked) and scrubbed with scripts/scrub-fixture.mjs --dom. Each
// element keeps its inline layout (display, position, order, visibility, opacity, font size)
// and where it was drawn relative to the post, in data-hfw-rect. Their glyph timestamps, with the
// absolutely positioned decoys among the letters, came through as drawn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines } from './helpers/fixtures.js';
import { readAdSignals } from '../src/features/feed/sponsored-dom.js';

const posts = (await fixtureLines('organic-posts.jsonl.gz')).map((line) => JSON.parse(line));

const rectOf = (element) => {
  const [left, top, width, height] = (element.getAttribute('data-hfw-rect') ?? '0,0,0,0').split(',').map(Number);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
};

// One post on a page of its own. With layout, each element reports the box it had live.
async function read(html, { layout, change } = {}) {
  const win = testWindow('https://www.facebook.com/');
  try {
    if (layout) {
      win.Element.prototype.getBoundingClientRect = function () {
        return rectOf(this);
      };
      win.Element.prototype.getClientRects = function () {
        const rect = rectOf(this);
        return rect.width || rect.height ? [rect] : [];
      };
    }
    win.document.body.innerHTML = html;
    const post = win.document.body.firstElementChild;
    change?.(post, win.document);
    return readAdSignals(post);
  } finally {
    await win.happyDOM.close();
  }
}

test('the fixture holds 100 posts from Home, the groups feed and search, each a post block', () => {
  assert.equal(posts.length, 100);
  const sources = {};
  for (const { source, html } of posts) {
    sources[source] = (sources[source] ?? 0) + 1;
    assert.match(html, /^<div aria-posinset="\d+"/);
  }
  assert.deepEqual(sources, { home: 40, groups: 35, search: 25 });
});

for (const layout of [false, true]) {
  test(`no organic post reads as an ad, ${layout ? 'laid out as drawn live' : 'without layout'}`, async () => {
    const ads = [];
    for (const [index, { source, html }] of posts.entries()) {
      const result = await read(html, { layout });
      if (result?.signal) ads.push(`${source} #${index}: ${result.signal} (${result.label})`);
    }
    assert.deepEqual(ads, []);
  });
}

// The check has to still see an ad in this markup, or the test above would pass on a check
// that sees nothing: a "Sponsored" label put in each post's header, in the byline row under the
// author's name (the name itself, Facebook's profile_name block, never counts).
test('the same posts with a Sponsored label in the header are caught', async () => {
  let caught = 0;
  let tried = 0;
  for (const { html } of posts) {
    const result = await read(html, {
      layout: true,
      change(post, doc) {
        const heading = post.querySelector('h2, h3, h4, [role="heading"]');
        if (!heading) return;
        tried++;
        const label = doc.createElement('span');
        label.setAttribute('style', 'display:inline');
        const top = rectOf(heading).top;
        label.setAttribute('data-hfw-rect', `60,${top + 20},70,16`);
        label.textContent = 'Sponsored';
        (heading.closest('[data-ad-rendering-role="profile_name"]') ?? heading).after(label);
      },
    });
    if (result?.signal) caught++;
  }
  assert.ok(tried >= 90, `${tried} posts had a header to put the label in`);
  assert.equal(caught, tried);
});

// The plain label above is read as text, which says nothing about the glyph decoder, the part
// that could misread an organic post. Two of these posts carry Facebook's scrambled glyph box in
// the header: the post's age ("1h", "9h") drawn by two letters in a flex row of 60, the other
// 58 positioned out of the flow as decoys (one post's decoys hold the letters of "Sponsored").
// An ad draws its label in that box in place of the age. So the age letters go out of the flow
// like the decoys, and nine spans put back in it, with flex orders and places that spell the
// label, have to be read as an ad by the decoder, with the other decoys still there.
const scrambledBox = (post) => [...post.querySelectorAll('span, div')]
  .find((el) => el.children.length >= 9 && [...el.children].some((child) => /order\s*:/.test(child.getAttribute('style') ?? '')));

for (const layout of [false, true]) {
  test(`a label spelled by the scrambled glyphs in those posts is decoded, ${layout ? 'laid out' : 'without layout'}`, async () => {
    const signals = [];
    for (const { html } of posts) {
      let box = null;
      const result = await read(html, {
        layout,
        change(post) {
          box = scrambledBox(post);
          if (!box) return;
          const [left, top] = box.getAttribute('data-hfw-rect').split(',').map(Number);
          box.setAttribute('data-hfw-rect', `${left},${top},80,16`);
          for (const span of box.children) {
            const style = span.getAttribute('style') ?? '';
            if (!/position\s*:\s*absolute/.test(style)) span.setAttribute('style', `${style};position:absolute`);
          }
          // Spans 0, 2, 4 and so on, given the letters in a shuffled order.
          const letters = [...'Sponsored'];
          const slots = [3, 7, 0, 5, 8, 1, 6, 2, 4];
          slots.forEach((place, i) => {
            const span = box.children[i * 2];
            span.textContent = letters[place];
            span.setAttribute('style', `display:block;order:${100 + place}`);
            span.setAttribute('data-hfw-rect', `${left + place * 8},${top},7,16`);
          });
        },
      });
      if (box) signals.push(result?.signal ?? 'missed');
    }
    assert.deepEqual(signals, ['glyph order', 'glyph order']);
  });
}
