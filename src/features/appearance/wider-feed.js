// Wider feed on Home: the posts grow to a width you pick, and the right column folds away when
// nothing in it shows. Works in content mode and switches off without a reload.
//
// Live 2026-11-04 (Home and its Favorites feed, signed in, 1600x1000):
// - Home is a row of the left column (360 px), role=main (flex 1 1 744px, 880 px) and
//   div#right_rail_container[role=complementary] (sticky, flex 0 9999 360px, 280 to 360 px).
//   With Hush hiding ads, the column held the Sponsored box alone, so it showed no words and no
//   picture and still took 360 px.
// - Facebook's 680 px is a width on one of the seven blocks between role=main and the posts'
//   list (an atomic class under @media (min-width: 1320px)). The others take their width from
//   it, and none has a margin, padding or border. So every one of them takes the new width,
//   capped by the room there is, and the list and the posts are left alone.
// - Home loads with one post drawn and the rest only as you scroll. The list already holds that
//   post and three placeholders then, so the width doesn't wait for a second post.
// - At 1000 px the Stories row, the post box and every post followed, photos and videos scaled
//   with their post, the page didn't scroll sideways and the round New message button in the
//   corner stayed clear of the feed.
// - The column is folded to no width rather than display:none. A column that isn't drawn
//   reports the words of everything in it, hidden or not, so it would come straight back.
// - The Feeds page (/feeds/) has no such column and its own side column inside role=main, so
//   it's left alone.
// Live 2026-11-04 again, an account with no friends' stories: Facebook shows a Create story card
// in place of the Stories row. It's a child of the column holding the post box and the posts,
// with 680 px of its own on that child, so it stayed narrow beside 1000 px posts. Taking that
// child's width off widened the whole card. The same column holds an empty 680 px block, and the
// block above the list holds a 1 px "Feed posts" heading for screen readers, which must stay
// 1 px. So a block beside the feed takes its width only when it's in the flow and 300 px or more.
// role=main pads itself 32 px on each side (seen at 1000, 1280, 1600 and 1919 px wide), which
// keeps the feed off the column, so Full width is all of role=main inside that padding.
// Birthdays: the account we used showed none in the column. Other extensions find the block by
// its link to /events/birthdays/ (the address the left column's Birthdays row uses too), so the
// block taken is the largest one around that link that holds no other link and no heading but
// its own, in front of it, with nothing drawn after it. Contacts would need its word, so it isn't
// touched.

import { whenRootReady } from '../../core/env.js';

export const WIDE_MARK = 'data-hfw-wide-feed';
export const FILL_MARK = 'data-hfw-wide-fill';
export const FOLDED_MARK = 'data-hfw-folded-column';
export const BIRTHDAYS_MARK = 'data-hfw-birthdays';

const HOME = 'html[data-hfw-route="home"]';
const COLUMN = '[role="complementary"]';
const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const BIRTHDAYS = '/events/birthdays';
const PICTURES = 'img, svg, video, canvas, iframe';
const FILL_FROM = 300;

// Full takes all the room Home has, between the left column and the right one, or the window's
// edge when the right column is folded. Any width is capped by that room.
export const FULL = 'full';
export const WIDTHS = ['800', '900', '1000', '1200', '1400', FULL];
const DEFAULT_WIDTH = '900';

export function widthOf(get) {
  const width = String(get('widerFeed.width'));
  return WIDTHS.includes(width) ? width : DEFAULT_WIDTH;
}

export function widerFeedCss(width, birthdays) {
  return [
    `${HOME} [${WIDE_MARK}] { box-sizing: border-box !important; width: ${width === FULL ? '100%' : `${width}px`} !important; max-width: 100% !important; }`,
    `${HOME} [${FILL_MARK}] { width: auto !important; max-width: 100% !important; }`,
    `${HOME} [${FOLDED_MARK}] { flex: 0 0 0px !important; width: 0 !important; min-width: 0 !important; max-width: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; overflow: hidden !important; }`,
    ...(birthdays ? [`${HOME} [${BIRTHDAYS_MARK}] { display: none !important; }`] : []),
  ].join('\n');
}

// The blocks between role=main and the list holding the posts, outermost last. The list is the
// first block above the first post that holds the last post and something else, so one post is
// enough: Home loads with one, next to three placeholders in the list.
export function feedWrappers(doc) {
  const main = doc.querySelector('[role="main"]');
  const posts = main?.querySelectorAll('[aria-posinset]') ?? [];
  if (posts.length === 0) return [];
  const last = posts[posts.length - 1];
  let list = posts[0].parentElement;
  while (list !== main && (!list.contains(last) || list.children.length < 2)) list = list.parentElement;
  if (list === main) return [];
  const wrappers = [];
  for (let block = list.parentElement; block !== main; block = block.parentElement) wrappers.push(block);
  return wrappers;
}

// Blocks beside the feed that hold a width of their own, such as the Create story card: a
// child of a plain block on the way down to the posts, in the flow and FILL_FROM px or wider,
// holding no post. A flex row would shrink a child that lost its width, so those are skipped.
export function fillBlocks(wrappers, view) {
  const fill = [];
  for (const wrapper of wrappers) {
    if (view.getComputedStyle(wrapper).display !== 'block') continue;
    for (const kid of wrapper.children) {
      if (wrappers.includes(kid) || kid.matches('[aria-posinset]') || kid.querySelector('[aria-posinset]')) continue;
      if (['absolute', 'fixed'].includes(view.getComputedStyle(kid).position)) continue;
      if (kid.getBoundingClientRect().width >= FILL_FROM) fill.push(kid);
    }
  }
  return fill;
}

// The page's own side columns, not one inside the feed or a dialog.
export const sideColumns = (doc) => [...doc.querySelectorAll(COLUMN)].filter((column) => !column.parentElement?.closest('[role="main"], [role="dialog"], [role="complementary"]'));

const drawn = (element) => element.checkVisibility?.({ visibilityProperty: true }) ?? element.getClientRects().length > 0;

// Whether anything in the column is on screen: a word or a picture.
export const showsSomething = (column) => Boolean(column.innerText.trim()) || [...column.querySelectorAll(PICTURES)].some(drawn);

const isBirthdaysLink = (a) => (a.getAttribute('href') ?? '').includes(BIRTHDAYS);

// A block that's still only the Birthdays box: every link goes to Birthdays and it has one heading
// at most. A heading after the link never gets this far, since followed() stops at it.
const onlyBirthdays = (block) => [...block.querySelectorAll('a[href]')].every(isBirthdaysLink) && block.querySelectorAll(HEADING).length <= 1;

const DRAWN = `[role="button"], button, ${PICTURES}`;

// Words, a button or a picture after the block, which the block above it would take in. A box
// below Birthdays whose title isn't a heading and whose rows aren't links stops the climb here.
function followed(block) {
  for (let next = block.nextElementSibling; next; next = next.nextElementSibling) {
    if (next.textContent.trim() || next.matches(DRAWN) || next.querySelector(DRAWN)) return true;
  }
  return false;
}

export function birthdaysBlocks(column) {
  const blocks = new Set();
  for (const link of column.querySelectorAll(`a[href*="${BIRTHDAYS}"]`)) {
    let block = link;
    for (let parent = block.parentElement; parent && parent !== column && !followed(block) && onlyBirthdays(parent); parent = parent.parentElement) block = parent;
    blocks.add(block);
  }
  return [...blocks];
}

// Puts mark on each element in wanted (element -> value) and takes it off everything else.
function sync(doc, mark, wanted) {
  for (const marked of doc.querySelectorAll(`[${mark}]`)) {
    if (!wanted.has(marked)) marked.removeAttribute(mark);
  }
  for (const [element, value] of wanted) {
    if (element.getAttribute(mark) !== value) element.setAttribute(mark, value);
  }
}

export default {
  id: 'widerFeed',
  section: 'layout',
  title: 'Wider feed on Home',
  description: "Lets Home's posts, the post box and Create story grow to the width you pick, up to all the room there is. The right column folds away when there's nothing left in it, which is often the case with ads hidden. Contacts and anything else Facebook shows there keep the column.",
  default: false,
  webOnly: true,
  options: [
    { key: 'width', type: 'select', label: 'Width', default: DEFAULT_WIDTH, choices: WIDTHS.map((value) => ({ value, label: value === FULL ? 'Full width' : `${value} px` })) },
    { key: 'birthdays', type: 'toggle', label: 'Hide Birthdays in the right column', default: false },
  ],
  css: (get) => widerFeedCss(widthOf(get), get('widerFeed.birthdays') === true),

  setup({ doc, router, settings, enabled }) {
    if (!doc) return;
    const onHome = () => router?.current()?.type === 'home';
    let queued = false;
    const check = () => {
      queued = false;
      const live = enabled() && onHome();
      const wrappers = live ? feedWrappers(doc) : [];
      sync(doc, WIDE_MARK, new Map(wrappers.map((block) => [block, ''])));
      sync(doc, FILL_MARK, new Map((view ? fillBlocks(wrappers, view) : []).map((block) => [block, ''])));
      const columns = live ? sideColumns(doc) : [];
      sync(doc, BIRTHDAYS_MARK, new Map(columns.flatMap(birthdaysBlocks).map((block) => [block, ''])));
      // After the Birthdays mark, so each column is judged as it's drawn now.
      sync(doc, FOLDED_MARK, new Map(columns.filter((column) => !showsSomething(column)).map((column) => [column, ''])));
    };
    const view = doc.defaultView;
    // Before the browser paints the change, once however many changes came in.
    const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
    const schedule = () => {
      if (queued) return;
      queued = true;
      frame(check);
    };
    const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
    const observer = new Observer(() => {
      if (enabled() && onHome()) schedule();
    });
    // A new address, the switch or the Birthdays option can change what's left in the column
    // without Facebook changing the page.
    router?.subscribe?.(schedule);
    settings?.subscribe?.(schedule);
    whenRootReady(() => {
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      check();
    }, doc);
  },
};
