// The Space under the Stories row line in a real engine (#13, #15), on Home's column as seen
// live on 2026-11-14: an empty block, the post box, the Stories block (the row and 12 px under
// it) and the feed (an empty block, the 1 px "Feed posts" heading laid over it and the list).
import { storiesGapLine } from '../../../src/core/dom/stories-gap.js';
import { check } from './helpers.js';

const POST = (n) => `<div><div aria-posinset="${n}" style="background:#242526;border-radius:8px;padding:12px 16px;margin-bottom:12px">A post</div></div>`;
const HIDDEN_POST = '<div style="min-height:118px"><div aria-posinset="1"><div data-hfw-hide="Suggested">A post</div></div></div>';
const HIDE = '<style class="gap-style">.gap-home :has(> [data-hfw-hide]) { display: none !important; }</style>';

const page = ({ beforeHeading = '', units = `${POST(1)}${POST(2)}`, tray = true } = {}) => `<div role="main" class="gap-home"><div style="width:680px">
  <div></div>
  <div style="height:62px;margin-bottom:12px;background:#242526"></div>
  <div style="padding-bottom:12px">${tray ? '<div data-focus-target="stories_tray" role="region" style="height:160px;background:#242526"><a href="/stories/create/">Create story</a></div>' : ''}</div>
  <div style="position:relative"><div>${beforeHeading}</div><h3 style="position:absolute;width:1px;height:1px;margin:0;overflow:hidden">Feed posts</h3><div class="list">${units}</div></div>
</div></div>`;

function mount(html) {
  document.querySelector('.gap-home')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

export async function storiesGap() {
  document.head.insertAdjacentHTML('beforeend', HIDE);
  const lines = {};

  mount(page());
  lines.stock = storiesGapLine(document, true);
  check(lines.stock === '12 px, as usual', `Stock Home: ${lines.stock}`);
  check(storiesGapLine(document, false) === 'Open Home to measure', `Off Home: ${storiesGapLine(document, false)}`);

  // An empty block over the heading that keeps 118 px.
  mount(page({ beforeHeading: '<div style="height:118px"></div>' }));
  lines.blank = storiesGapLine(document, true);
  check(lines.blank === '130 px: div 118 px', `A blank block over the feed: ${lines.blank}`);

  // The first post hidden by the script, in a unit that keeps a min-height.
  mount(page({ units: `${HIDDEN_POST}${POST(2)}` }));
  lines.unit = storiesGapLine(document, true);
  check(lines.unit === '130 px: div 118 px, min-height 118 px, holds a hidden post, marked hide', `A hidden first post's unit: ${lines.unit}`);

  // Nothing drawn yet, and a page with no Stories row.
  mount(page({ units: '<div></div><div></div>' }));
  lines.noPost = storiesGapLine(document, true);
  check(lines.noPost === 'No post drawn yet', `No post: ${lines.noPost}`);
  mount(page({ tray: false }));
  lines.noRow = storiesGapLine(document, true);
  check(lines.noRow === 'No Stories row on this page', `No row: ${lines.noRow}`);

  document.querySelector('.gap-home')?.remove();
  document.querySelector('.gap-style')?.remove();
  return lines;
}
