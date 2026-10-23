// Screenshot mode: blurs names, profile pictures and group names, so a screenshot of Facebook
// can be shared without them. #7 asked for cleaner screenshots, and Social Fixer blurs names
// and pictures for the same reason. CSS only: nothing is read or sent, it works in content
// mode, and everything is sharp again the moment it's off.
//
// Live 2026-10-22, signed out (NASA's Page, one of its posts with 103 comments, a public group
// and a public reel):
// - Every profile picture is an <svg> drawing an <image> behind a round or square mask, 32 to
//   168 px: post headers, comments, Page and group cards, a reel's poster, the top bar's own
//   picture. Photos in posts, reactions and emoji are plain <img>, so they stay sharp.
// - A post's author line is [data-ad-rendering-role="profile_name"], with its "is with" and
//   "is at" tags, on a Page, in a group and in the related posts under one.
// - A comment (role=article with an aria-label) starts with its author: the bubble's first span,
//   holding a span[dir=auto] with no lang, inside a link when the person has one. A badge
//   (Author, Top fan) can sit in front of it as a div, so it's the first span, not the first
//   child. The comment's own text is a span[dir=auto] with a lang.
// - The name at the top of a Page, profile or group is the h1 in role=main, and the cover photo
//   is img[data-imgperflogname="profileCoverPhoto"]. A group's own tabs (About, Media) link
//   under /groups/ too, so group names are found by place, not by address.
// - A reel's poster is a button in an h2[dir=auto] > span[dir=auto]. Its audio line ("Name ·
//   Original audio") is a scrolling marquee, [data-type="hscroll-child"], holding the words three
//   times inside one labelled div. No other page we opened had that marquee.
// - People and Pages named in a post or comment are links to facebook.com. Hashtags and links
//   that leave through l.facebook.com aren't names.
// Not seen live yet (signed in only): the left column's own row and shortcuts, the right
// column's contacts, and a group post's group line on Home. Those rules only reach a link or
// button holding a profile picture inside that column, or a group link in a post's heading.

import { LEFT } from './declutter-table.js';

const FACEBOOK_LINK = 'a[href*="facebook.com/"]:not([href*="l.facebook.com"], [href*="/hashtag/"])';
const COMMENT = '[role="article"][aria-label]';

export const PICTURES = [
  'svg:has(image)',
  'img[data-imgperflogname="profileCoverPhoto"]',
];

export const NAMES = [
  '[data-ad-rendering-role="profile_name"]',
  `${COMMENT} div > span:first-of-type:has(span[dir="auto"]:not([lang]))`,
  `[data-ad-rendering-role="story_message"] ${FACEBOOK_LINK}`,
  `${COMMENT} span[lang] ${FACEBOOK_LINK}`,
  'a[href*="/user/"]',
  'a[href*="profile.php"]',
  'a[href*="/people/"]',
  '[role="main"] h1',
  'h2[dir="auto"] > span[dir="auto"] [role="button"]',
  '[data-type="hscroll-child"] [role="button"] [aria-label]',
  `${LEFT} a:has(svg image)`,
  '[role="complementary"] :is(a, [role="button"]):has(svg image)',
  '[aria-posinset] :is(h2, h3, h4) a[href*="/groups/"]',
];

export const SCREENSHOT_CSS = `${PICTURES.join(',\n')} { filter: blur(8px) !important; }
${NAMES.join(',\n')} { filter: blur(5px) !important; }`;

export default {
  id: 'screenshotMode',
  section: 'appearance',
  android: 'Screenshot mode',
  title: 'Screenshot mode',
  description: "Blurs people's names, profile pictures and group names while it's on, so you can share a screenshot without them. Posts, photos and comments stay readable, and nothing leaves your browser.",
  default: false,
  css: SCREENSHOT_CSS,
};
