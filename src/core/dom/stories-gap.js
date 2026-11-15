// The room between Home's Stories row and the first post drawn, and what takes it up, for
// Diagnostics. Two people saw about 130 px of empty page there on 0.0.21 with a full Stories
// row (#13, #15). The test account, with one friend's story, never showed it in nine runs on
// 2026-11-14: a fresh load and the Home button, defaults, every switch on, the first reporter's
// settings, and the first post hidden by a filter with and without its note. Stock Home leaves
// 12 px there.
//
// So the row names each block that takes up that room, using none of the page's words: the
// blocks after the Stories row on its way up to the column it shares with the posts, then the
// blocks before the first post on its way up to that column, each with its height, the marks
// this script put on or in it, and how many links, pictures and letters it holds. Copy report
// carries the row, so a report shows which block it is.
//
// The room can also be inside the row itself. On 2026-11-15 the first reporter's devtools showed
// every story card's box 280.9 px tall around a 160 px card, so the row ended 120 px below its
// cards and measuring from the row's bottom read as usual. The test account's row ends 16 px
// below its cards (its own padding) with defaults, every switch off, no script and the
// reporter's settings. So the line also measures from where the cards end and names the deepest
// boxes that reach past them, alike ones counted together.

const TRAY = '[data-focus-target="stories_tray"]';
// An account with no friends' stories gets a Create story card in place of the row.
const CREATE = 'a[href*="/stories/create"]';
// A story card is a link this tall at least. Live they're 160 px; a short text link can't say
// where the cards end.
const STORY_CARD = 'a[href*="/stories/"]';
const CARD = 80;
const PICTURES = 'img, svg, video, canvas';
const LOADING = '[data-visualcompletion="loading-state"]';
// More than this between the row and the post, or inside the row below its cards, is reported
// block by block.
export const USUAL_GAP = 40;
// Blocks shown at most, so the line stays short enough for Copy report.
const MOST = 4;
// Padding, a margin or the part of a block below the row that's worth naming, in px. Stock
// Home's Stories block reaches 12 px below the row.
const SPACE = 16;

const boxOf = (element) => element.getBoundingClientRect();

// The first post drawn on the page: a feed unit with a box, not one inside another post.
export function firstDrawnPost(main) {
  for (const post of main.querySelectorAll('[aria-posinset]')) {
    if (post.parentElement?.closest('[aria-posinset]')) continue;
    if (boxOf(post).height > 0) return post;
  }
  return null;
}

// The marks this script put on a block or inside it, by name.
function ourMarks(block) {
  const names = new Set();
  for (const element of [block, ...block.querySelectorAll('*')]) {
    for (const { name } of element.attributes) {
      if (name.startsWith('data-hfw-')) names.add(name.slice('data-hfw-'.length));
    }
  }
  return [...names].sort();
}

// One block in the room, in the script's own words only.
export function describeBlock(block, view) {
  const style = view.getComputedStyle(block);
  const role = block.getAttribute('role');
  const parts = [`${block.localName}${role ? ` ${role}` : ''} ${Math.round(boxOf(block).height)} px`];
  const padding = Math.round(parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
  if (padding > 0) parts.push(`padding ${padding} px`);
  const margin = Math.round(parseFloat(style.marginTop) + parseFloat(style.marginBottom));
  if (margin > 0) parts.push(`margin ${margin} px`);
  const minHeight = parseFloat(style.minHeight);
  if (minHeight > 0) parts.push(`min-height ${Math.round(minHeight)} px`);
  const links = block.querySelectorAll('a[href]').length;
  if (links) parts.push(`${links} links`);
  const pictures = [...block.querySelectorAll(PICTURES)].filter((picture) => boxOf(picture).height > 0).length;
  if (pictures) parts.push(`${pictures} pictures`);
  const letters = (block.innerText ?? '').replace(/\s/g, '').length;
  if (letters) parts.push(`${letters} letters`);
  if (block.matches(LOADING) || block.querySelector(LOADING)) parts.push('loading card');
  const held = block.querySelector('[aria-posinset]');
  if (held) parts.push(boxOf(held).height > 0 ? 'holds a post' : 'holds a hidden post');
  const marks = ourMarks(block);
  if (marks.length) parts.push(`marked ${marks.join('/')}`);
  return parts.join(', ');
}

// Whether a block sits in the room between top and bottom, with a box of its own.
const inRoom = (block, top, bottom) => {
  const box = boxOf(block);
  return box.height >= 2 && box.bottom > top + 1 && box.top < bottom - 1;
};

// Where the cards end in the row: the bottom most of its story cards share, so one stretched
// card can't move it. Null when the row has no card-sized story link.
function cardsBottom(row) {
  const counts = new Map();
  for (const link of row.querySelectorAll(STORY_CARD)) {
    const box = boxOf(link);
    if (box.height < CARD) continue;
    const bottom = Math.round(box.bottom);
    counts.set(bottom, (counts.get(bottom) ?? 0) + 1);
  }
  let end = null;
  for (const [bottom, count] of counts) {
    const best = end === null ? 0 : counts.get(end);
    if (count > best || (count === best && bottom < end)) end = bottom;
  }
  return end;
}

// The room inside the Stories row below its cards and the deepest boxes reaching into it, alike
// boxes side by side counted as one (stretched card boxes come in a run). Lone boxes come first,
// since a box that's tall on its own is what stretches the rest. Null without card-sized cards.
export function measureRoomInRow(row, view) {
  const end = cardsBottom(row);
  if (end === null) return null;
  const room = Math.round(boxOf(row).bottom - end);
  if (room <= USUAL_GAP) return { room, blocks: [] };
  const reaching = [...row.querySelectorAll('*')].filter((element) => {
    const box = boxOf(element);
    return box.height >= 2 && box.bottom > end + SPACE;
  });
  const deepest = reaching.filter((element) => !reaching.some((other) => other !== element && element.contains(other)));
  const groups = [];
  for (const element of deepest) {
    const key = `${element.localName} ${element.getAttribute('role') ?? ''} ${Math.round(boxOf(element).height)}`;
    const group = groups.find((entry) => entry.parent === element.parentElement && entry.key === key);
    if (group) group.count++;
    else groups.push({ parent: element.parentElement, key, first: element, count: 1 });
  }
  groups.sort((a, b) => Math.min(a.count, 2) - Math.min(b.count, 2));
  const blocks = groups.map(({ first, count }) => `${describeBlock(first, view)}${count > 1 ? `, and ${count - 1} more like it` : ''}`);
  return { room, blocks };
}

// The Stories row's bottom, the first post's top and the blocks between them, or why not, with
// the room inside the row below its cards.
export function measureStoriesGap(doc) {
  const view = doc.defaultView;
  const main = doc.querySelector('[role="main"]');
  if (!main || !view) return { state: 'no-page' };
  const row = main.querySelector(TRAY) ?? main.querySelector(CREATE);
  if (!row) return { state: 'no-row' };
  const post = firstDrawnPost(main);
  if (!post) return { state: 'no-post' };
  const top = boxOf(row).bottom;
  const bottom = boxOf(post).top;
  const gap = Math.round(bottom - top);
  const inside = row.matches(TRAY) ? measureRoomInRow(row, view) : null;
  if (gap <= USUAL_GAP) return { state: 'usual', gap, inside };
  const column = commonAncestor(row, post);
  const blocks = [];
  const note = (block) => {
    if (!blocks.includes(block) && inRoom(block, top, bottom)) blocks.push(block);
  };
  // After the row, inside the blocks that hold it. A block holding the row that reaches well
  // below it has room of its own (padding, a min-height or something hidden).
  for (let element = row; element && element !== column; element = element.parentElement) {
    for (let next = element.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.contains(post)) break;
      note(next);
    }
    if (element !== row && boxOf(element).bottom - top > SPACE) note(element);
  }
  // Before the post, inside the blocks that hold it, back to the one holding the row. A block
  // holding the post adds room only by its own padding or margin on top.
  for (let element = post; element && element !== column; element = element.parentElement) {
    for (let previous = element.previousElementSibling; previous; previous = previous.previousElementSibling) {
      if (previous.contains(row)) break;
      note(previous);
    }
    const style = view.getComputedStyle(element);
    if ((parseFloat(style.paddingTop) > SPACE || parseFloat(style.marginTop) > SPACE) && !blocks.includes(element)) blocks.push(element);
  }
  return { state: 'gap', gap, blocks: blocks.map((block) => describeBlock(block, view)), inside };
}

function commonAncestor(a, b) {
  for (let element = a.parentElement; element; element = element.parentElement) {
    if (element.contains(b)) return element;
  }
  return a.ownerDocument.documentElement;
}

// The Diagnostics line.
export function storiesGapLine(doc, onHome) {
  if (!onHome) return 'Open Home to measure';
  const found = measureStoriesGap(doc);
  if (found.state === 'no-page' || found.state === 'no-row') return 'No Stories row on this page';
  if (found.state === 'no-post') return 'No post drawn yet';
  const under = found.state === 'usual' ? `${found.gap} px, as usual` : `${found.gap} px${listOf(found.blocks)}`;
  if (!found.inside || found.inside.room <= USUAL_GAP) return under;
  return `${under}. The row reaches ${found.inside.room} px below its cards${listOf(found.inside.blocks)}`;
}

function listOf(blocks) {
  const shown = blocks.slice(0, MOST);
  const more = blocks.length - shown.length;
  return shown.length ? `: ${shown.join('; ')}${more > 0 ? `; ${more} more` : ''}` : ', with no block of its own in it';
}
