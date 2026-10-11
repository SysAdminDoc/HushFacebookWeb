// Every piece of Facebook's own furniture that a Declutter switch can hide, one row each, so a
// change on Facebook's side is a one-line fix here. Nothing is keyed on class names or on
// words: a row is found by the address its link goes to, and the box hidden is the list item
// that holds it, so the space goes too.
//
// Live 2026-10-11 (Home, 1600 px, captures/2026-10-11-declutter*):
// - Top bar tabs: [role=banner] [role=navigation] ul > li > span > div > a[aria-label][href="/friends/"].
//   This account has Home, Friends and Groups; others also get Video (/watch/ or /reel/),
//   Marketplace and Gaming. "Find friends" is a[href="/friends/"] without an aria-label, in a
//   div of its own beside the Menu, Messenger, Notifications and profile buttons.
// - Left column: a [role=navigation] outside the top bar; each row is li > div > div > div > a
//   with an absolute address (https://www.facebook.com/marketplace/). Facebook's other apps and
//   devices go through l.facebook.com/l.php?u=... (Meta AI to www.meta.ai, Meta Quest 3S,
//   Ray-Ban Meta). "See more" opens the rest in the same list.
// - Facebook menu (the grid button): [role=dialog] with each row a [role=listitem] holding its
//   link. Its "More from Meta" rows leave Facebook too (Meta AI, Meta Quest 3S, WhatsApp,
//   Instagram), and Messenger Kids is /messenger_kids/. The Create column has /ads/create_ad/.

// The left column is the navigation outside the top bar that links Friends and Groups, and the
// Facebook menu is the dialog with the Create column's Page and Event links. Anything looser
// would also reach a post opened in a dialog, where a comment's outside link sits in a list.
// Its links are absolute and carry a query string (a[href$="/marketplace/"] found nothing
// live), while the top bar's tabs are relative, which keeps the tabs out even where
// :not([role=banner] *) isn't understood (happy-dom).
const LEFT = '[role="navigation"]:not([role="banner"] *):has(a[href^="https://www.facebook.com/friends/"]):has(a[href^="https://www.facebook.com/groups/"])';
const MENU = '[role="dialog"]:has(a[href*="/pages/creation/"]):has(a[href*="/events/create/"])';

// A link to one of Facebook's own sections, relative in the top bar and absolute elsewhere,
// with or without a query string.
export function section(path) {
  return [`a[href="${path}"]`, `a[href^="${path}?"]`, `a[href="https://www.facebook.com${path}"]`, `a[href^="https://www.facebook.com${path}?"]`].join(', ');
}

// Links that leave Facebook: through its redirect, or straight out once Skip Facebook's link
// redirect has rewritten one on click.
export const OFFSITE = 'a[href*="l.facebook.com/l.php"], a[href^="http"]:not([href*="facebook.com"]):not([href*="fbcdn.net"])';

export const TAB_ROWS = [
  { option: 'video', label: 'Video', link: [section('/watch/'), section('/reel/'), section('/video/')].join(', ') },
  { option: 'marketplace', label: 'Marketplace', link: section('/marketplace/') },
  { option: 'gaming', label: 'Gaming', link: section('/gaming/') },
  { option: 'groups', label: 'Groups', link: section('/groups/') },
  { option: 'friends', label: 'Friends', link: section('/friends/') },
];

export const PROMOTION_ROWS = [
  { option: 'ads', label: 'Ads Manager, Your Ad Activity and Create an ad', link: [section('/ad_campaign/landing.php'), section('/adsmanager/'), section('/ads/activity/'), 'a[href^="/ads/create_ad/"]', 'a[href^="https://www.facebook.com/ads/create_ad/"]'].join(', ') },
  { option: 'gaming', label: 'Gaming Video and Play games', link: [section('/gaming/'), section('/gaming/play/')].join(', ') },
];

// Meta's other apps and devices. Meta Verified and Threads pitches haven't shown up on the web
// for the test account, so there's no row for them yet.
export const UPSELL_LINK = [OFFSITE, section('/messenger_kids/')].join(', ');

// The box to hide for each place, given a link selector list.
const each = (link, wrap) => link.split(/,\s*(?![^()]*\))/).map(wrap).join(',\n');

export const place = {
  tab: (link) => each(link, (a) => `[role="banner"] li:has(${a})`),
  left: (link) => each(link, (a) => `${LEFT} li:has(${a})`),
  menu: (link) => each(link, (a) => `${MENU} [role="listitem"]:has(${a})`),
};

export const FIND_FRIENDS = '[role="banner"] [role="navigation"] div:has(> a[href^="/friends/"]:not([aria-label]))';

export const hide = (selectors) => `${selectors} { display: none !important; }`;
