import { MARK, SHOW_ALL, createHider, hideCss } from '../../../src/core/dom/hide.js';
import { check } from './helpers.js';

// The note line's two buttons in real layout: Show hidden gets a box of its own beside the note,
// a click there lands on it, and it shows every hidden post. The post's first element is styled
// the way Facebook's are (padding, a background, an overlay in ::before) to prove the rules clear it.
const post = (n) => `<div class="slot"><div aria-posinset="${n}"><div class="inner"><div class="head"><a href="/someone">Someone ${n}</a></div><a class="time" href="/someone/posts/pfbid0Fixture${n}">2h</a><p>Post number ${n}</p></div><div class="footer"><button>Like</button></div></div></div>`;

export async function hiddenNote() {
  const page = document.createElement('style');
  page.textContent = '.inner { display: contents; } .head { position: relative; padding: 24px; background: #3a1d1d; color: #fff; font-size: 18px; } .head::before { content: "overlay"; position: absolute; inset: 0; } .head::after { content: "after"; } .footer { padding: 8px; }';
  const rules = document.createElement('style');
  rules.textContent = hideCss({ notes: true });
  document.head.append(page, rules);
  const feed = document.createElement('main');
  feed.innerHTML = [1, 2, 3].map(post).join('');
  document.body.append(feed);
  const hider = createHider({ doc: document });
  const posts = [...feed.querySelectorAll('[aria-posinset]')];
  posts.forEach((element, i) => check(hider.hide(element, i === 1 ? 'Filter' : 'Sponsored', i === 1 ? 'cats' : undefined), `Post ${i + 1} was not hidden`));

  const [first] = posts;
  const mark = first.querySelector(`[${MARK}]`);
  const button = mark.firstElementChild;
  const box = mark.getBoundingClientRect();
  const own = button.getBoundingClientRect();
  check(getComputedStyle(button, '::before').content === `"${SHOW_ALL}"`, 'Show hidden has no label');
  check(getComputedStyle(button, '::after').content === 'none', "Facebook's ::after still draws on Show hidden");
  check(own.width > 40 && own.height > 30, `Show hidden has no box of its own (${own.width}x${own.height})`);
  check(own.right <= box.right + 0.5 && own.left > box.left + 60, 'Show hidden is not at the end of the note line');
  check(Math.abs(own.top - box.top) < 1 && Math.abs(own.bottom - box.bottom) < 1, 'Show hidden is not as tall as the note');
  check(!first.querySelector('.head a').checkVisibility() && !first.querySelector('.footer').checkVisibility(), 'Part of the hidden post still shows');
  check(document.elementFromPoint(box.left + 10, box.top + own.height / 2) === mark, 'A click on the note text does not land on the note');
  const center = { x: own.left + own.width / 2, y: own.top + own.height / 2 };
  const target = document.elementFromPoint(center.x, center.y);
  check(target === button, 'A click on Show hidden does not land on it');
  button.focus();
  check(document.activeElement === button, 'Show hidden does not take focus');
  button.blur();

  const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: center.x, clientY: center.y });
  target.dispatchEvent(click);
  check(click.defaultPrevented, 'The click went on to the page');
  check(!document.querySelector(`[${MARK}]`), 'A post is still hidden');
  check(posts.every((element) => element.querySelector('.time').checkVisibility() && element.querySelector('.footer').checkVisibility()), 'A post did not come back');
  check(getComputedStyle(button, '::before').content === '"overlay"', "Facebook's own look did not come back");

  feed.insertAdjacentHTML('beforeend', post(4));
  const later = feed.querySelector('[aria-posinset="4"]');
  check(hider.hide(later, 'Sponsored'), 'A later post was not hidden');
  check(!later.querySelector('.time').checkVisibility() && later.querySelector('.head').checkVisibility(), 'The later post has no note line');
  return { note: Math.round(box.width - own.width), showHidden: Math.round(own.width) };
}
