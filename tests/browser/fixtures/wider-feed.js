// Wider feed on Home in a real engine, at 1600x1000 with Home's flex values as seen live on
// 2026-11-04: the left column, role=main (flex 1 1 744px, centering) and the right column
// (sticky, flex 0 9999 360px, 280 to 360 px), with Facebook's 680 px on one block of seven.
// Whether a folded column still notices words coming into it is only known here: happy-dom
// lays nothing out.
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { mountFeatureStyles } from '../../../src/core/style.js';
import widerFeedFeature, { FOLDED_MARK } from '../../../src/features/appearance/wider-feed.js';
import hideSponsoredPosts from '../../../src/features/feed/hide-sponsored-posts.js';
import { COLUMN_AD_MARK } from '../../../src/features/feed/sponsored-column.js';
import { check, delay, until } from './helpers.js';

const PICTURE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#3a6"/></svg>');
const POST = (n) => `<div><div><div aria-posinset="${n}" class="post" style="background:#242526;border-radius:8px;margin-bottom:16px;padding:12px 0"><div style="padding:0 16px">A post</div><img src="${PICTURE}" alt="" style="display:block;width:100%;height:auto"></div></div></div>`;
const AD = `<div ${COLUMN_AD_MARK}=""><h3>Sponsored</h3><a href="https://l.facebook.com/l.php?u=x"><img src="${PICTURE}" alt="" width="120"><span>Shop now</span></a></div>`;
const CONTACTS = '<div class="contacts"><h2>Contacts</h2><div role="button"><span>Pat Example</span></div></div>';

const PAGE = `<style>
  .fb-page { display: flex; justify-content: space-between; }
  .fb-left { flex: 0 1 360px; min-width: 280px; height: 600px; background: #202124; }
  .fb-main { display: flex; flex: 1 1 744px; justify-content: center; min-width: 0; position: relative; }
  .fb-outer { display: flex; flex: 0 0 auto; flex-direction: column; max-width: 100%; box-sizing: border-box; }
  .fb-row { display: flex; justify-content: center; }
  .fb-full { width: 100%; }
  @media (min-width: 1320px) { .fb-col { width: 680px; } }
  .fb-col { max-width: 100%; }
  .fb-side { position: sticky; top: 0; flex: 0 9999 360px; min-width: 280px; max-width: 360px; height: 900px; background: #1c1d1f; }
</style>
<div class="fb-page">
  <div class="fb-left" role="navigation"></div>
  <div class="fb-main" role="main"><div class="fb-outer"><div><div class="fb-full"><div class="fb-row"><div class="fb-col">
    <div></div><div role="region" style="height:60px;background:#242526;margin-bottom:16px"></div><div><div data-focus-target="stories_tray" role="region" style="height:160px;background:#242526;margin-bottom:16px"></div></div>
    <div><div><div class="list">${POST(1)}${POST(2)}${POST(3)}</div></div></div>
  </div></div></div></div></div></div>
  <div class="fb-side" role="complementary"><div class="inner">${AD}</div></div>
</div>`;

const width = (el) => Math.round(el.getBoundingClientRect().width);

export async function widerFeed() {
  document.documentElement.dataset.hfwRoute = 'home';
  const features = [hideSponsoredPosts, widerFeedFeature];
  const settings = createSettings({ storage: createMemoryStorage(), features, migrations: [] });
  settings.set('hideSponsoredPosts', true);
  mountFeatureStyles({ features, settings, doc: document });
  document.body.insertAdjacentHTML('beforeend', PAGE);
  const main = document.querySelector('[role="main"]');
  const side = document.querySelector('[role="complementary"]');
  const post = document.querySelector('.post');
  const picture = post.querySelector('img');
  check(width(post) === 680 && width(side) === 360, `Facebook's own layout: post ${width(post)}, column ${width(side)}`);
  const sideways = () => document.scrollingElement.scrollWidth > innerWidth;

  settings.set('widerFeed', true);
  widerFeedFeature.setup({ doc: document, router: { current: () => ({ type: 'home' }), subscribe() {} }, settings, enabled: () => settings.enabled('widerFeed') });
  await until(() => side.hasAttribute(FOLDED_MARK) && width(post) === 900, `the column didn't fold or the feed didn't widen: post ${width(post)}, column ${width(side)}`);
  check(width(side) === 0, `the folded column still takes ${width(side)} px`);
  const room = width(main);
  check(room > 1100, `role=main didn't take the column's room: ${room}`);
  check(width(picture) === width(post), `a photo didn't follow its post: ${width(picture)} of ${width(post)}`);
  check(!sideways(), 'the page scrolls sideways at 900 px');

  settings.set('widerFeed.width', '1000');
  await until(() => width(post) === 1000, `the 1000 px pick: ${width(post)}`);
  // The width shows before the next check runs, so give it frames to undo the fold.
  await delay(100);
  check(side.hasAttribute(FOLDED_MARK) && width(side) === 0 && width(post) === 1000, `the folded column came back on its own: post ${width(post)}, column ${width(side)}`);
  check(!sideways(), 'the page scrolls sideways at 1000 px');
  const atWidest = { post: width(post), main: width(main) };

  // Contacts come in while the column is folded: the column opens and the feed fits beside it.
  document.querySelector('.inner').insertAdjacentHTML('beforeend', CONTACTS);
  await until(() => !side.hasAttribute(FOLDED_MARK) && width(side) >= 280, `a folded column missed its contacts: ${width(side)} px`);
  const gap = side.getBoundingClientRect().left - post.getBoundingClientRect().right;
  check(gap >= 15, `the feed runs into the column: ${Math.round(gap)} px apart`);
  check(width(post) < 1000 && Math.abs(width(post) - (width(main) - 32)) <= 1, `beside the column the feed should take role=main less the gaps: ${width(post)} of ${width(main)}`);
  check(!sideways(), 'the page scrolls sideways beside the column');

  document.querySelector('.contacts').remove();
  await until(() => side.hasAttribute(FOLDED_MARK) && width(post) === 1000, 'the column stayed open after its contacts left');
  await delay(100);
  check(side.hasAttribute(FOLDED_MARK) && width(side) === 0, `the column opened again with nothing in it: ${width(side)} px`);

  settings.set('widerFeed', false);
  await until(() => width(post) === 680 && width(side) === 360, `switching off left post ${width(post)}, column ${width(side)}`);
  await until(() => !document.querySelector(`[${FOLDED_MARK}]`), 'switching off left the fold mark');
  settings.set('widerFeed', true);
  await until(() => width(post) === 1000, 'switching back on');
  return { folded: true, widest: atWidest, besideColumn: true };
}
