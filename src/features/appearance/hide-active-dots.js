// Hide active status dots: the green dot Facebook puts on the corner of someone's profile
// picture while they're active. CSS only, so it works in content mode and switches off at once.
// Your own Active Status isn't touched; that stays a Facebook setting.
//
// Saved pages 2026-10-10 to 2026-10-11 (captures/, 2,706 files, 126 corner badges):
// - A corner badge is a div[data-visualcompletion=ignore] placed by an inline style ending in
//   transform: translate(50%, 50%) ("bottom: 5px; right: 5px; ..." once drawn, "bottom:6px;..."
//   in the server's HTML), in the same div as the picture's svg, two places after it.
// - The dot (7 of them, on post and comment pictures) holds div[aria-hidden=false] > div > span
//   with the hidden words "Online status indicator", then a hidden "Active". No picture.
// - Every other badge (119: the reaction and comment drawings on notifications and the like)
//   holds div > div[aria-hidden=true] around an svg, an i or an img.
// - The picture's svg mask cuts a notch for the badge: a circle with fill=black and
//   data-visualcompletion=ignore at the corner. Hiding the dot alone would leave a bite out of
//   the picture, so the notch goes too, only beside a dot.
// The words are in the page's language, so nothing here reads them.

import { hide } from './declutter-table.js';

const BADGE = '[data-visualcompletion="ignore"][style*="translate(50%, 50%)"]';

export const ACTIVE_DOT_SELECTORS = [
  `${BADGE}:has(> [aria-hidden="false"]):not(:has(img, svg, i))`,
  // The picture beside a dot, the same badges as above. :has() can't hold another :has(), so
  // the holder is checked twice instead.
  `:has(> ${BADGE} > [aria-hidden="false"]):not(:has(> ${BADGE} :is(img, svg, i))) > svg mask circle[fill="black"][data-visualcompletion="ignore"]`,
];

// A rule apiece, so a browser that turns one selector down still applies the other.
export const ACTIVE_DOTS_CSS = ACTIVE_DOT_SELECTORS.map(hide).join('\n');

export default {
  id: 'hideActiveDots',
  section: 'appearance',
  title: 'Hide active status dots',
  description: "Takes the green dot off people's profile pictures, so you don't see who's online. Your own Active Status doesn't change, that's still in Facebook's settings.",
  default: false,
  webOnly: true,
  css: ACTIVE_DOTS_CSS,
};
