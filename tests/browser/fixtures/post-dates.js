// Show full post dates in a real engine. The date is no node of its own (a span put into a
// server-drawn post made React throw #418, live 2026-11-05): the header row carries it as
// attributes and the row's ::after draws it, with order seating it after the time's box and
// before the dot and audience icon. Where that lands on screen is only known here: happy-dom
// lays nothing out.
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { mountFeatureStyles } from '../../../src/core/style.js';
import keepPostDates, { DATE_MARK, showDate } from '../../../src/features/feed/post-dates.js';
import { check } from './helpers.js';

const TIME = '<a href="/groups/12345678/posts/987654321/?__cft__[0]=AZx" role="link" tabindex="0" target="_blank"><span>2h</span></a>';
// Facebook's header as seen live 2026-10-11 (run 68): a wrapping flex row of the time's box, the
// dot and the audience icon.
const ROW_POST = `<div aria-posinset="1" class="post">
  <h3><span><a href="/groups/12345678/" role="link">Venice Beach Florida</a></span></h3>
  <div class="row" style="display: flex; flex-wrap: wrap; align-items: center; font-size: 13px"><span class="box" style="display: block"><span style="display: block">${TIME}</span></span><span class="dot" aria-hidden="true"> · </span><span class="icon"><svg width="12" height="12"><circle cx="6" cy="6" r="6" fill="#b0b3b8"/></svg></span></div>
  <div data-ad-rendering-role="story_message"><div>A post with a header row</div></div>
</div>`;
const PLAIN_POST = `<div aria-posinset="2" class="post">
  <h3><span><a href="/groups/12345678/" role="link">Venice Beach Florida</a></span></h3>
  <span class="plain"><span>${TIME}</span></span>
  <div data-ad-rendering-role="story_message"><div>A post with no header row</div></div>
</div>`;

const SECONDS = 1760221440;
const rect = (el) => el.getBoundingClientRect();

export async function postDates() {
  const features = [keepPostDates];
  const settings = createSettings({ storage: createMemoryStorage(), features, migrations: [] });
  settings.set('keepPostDates', true);
  mountFeatureStyles({ features, settings, doc: document });
  const feed = document.createElement('main');
  feed.innerHTML = ROW_POST + PLAIN_POST;
  document.body.append(feed);
  const [withRow, plain] = feed.querySelectorAll('[aria-posinset]');
  const before = feed.querySelectorAll('*').length;
  const text = feed.textContent;
  const now = SECONDS + 3600;
  check(showDate(document, withRow, SECONDS, 'en-US', now) && showDate(document, plain, SECONDS, 'en-US', now), 'A date was not shown');
  check(feed.querySelectorAll('*').length === before && feed.textContent === text, "Showing the date changed Facebook's nodes or text");

  const row = withRow.querySelector('.row');
  const drawn = getComputedStyle(row, '::after');
  check(/Oct 1[12], 2025/.test(drawn.content), `The row draws no date (${drawn.content})`);
  check(drawn.order === '1' && getComputedStyle(withRow.querySelector('.dot')).order === '2', `The date is not seated by order (${drawn.order})`);
  // ::after has no box to read, so where it sits shows in the gap it leaves between the time's
  // box and the dot.
  const box = rect(withRow.querySelector('.box'));
  const dot = rect(withRow.querySelector('.dot'));
  const icon = rect(withRow.querySelector('.icon'));
  check(dot.left - box.right > 100, `The date is not between the time and the dot (gap ${Math.round(dot.left - box.right)} px)`);
  check(Math.abs(dot.top - box.top) < 6 && Math.abs(icon.top - box.top) < 8, 'The dot or icon dropped to another line');
  check(icon.left > dot.left, 'The icon came before the dot');
  const shown = row.getBoundingClientRect();
  check(shown.height < 30, `The header row wrapped (${Math.round(shown.height)} px tall)`);

  const plainHost = plain.querySelector(`[${DATE_MARK}]`);
  check(plainHost === plain.querySelector('.plain > span'), 'With no row, the date is not on the link\'s own parent');
  const link = rect(plain.querySelector('a[target]'));
  const host = rect(plainHost);
  check(/Oct 1[12], 2025/.test(getComputedStyle(plainHost, '::after').content) && host.right - link.right > 100, 'With no row, the date does not follow the link');

  settings.set('keepPostDates', false);
  check(getComputedStyle(row, '::after').content === 'none' || !row.hasAttribute(DATE_MARK), 'Switched off, the date still draws');
  settings.set('keepPostDates', true);
  return { gap: Math.round(dot.left - box.right), row: Math.round(shown.height) };
}
